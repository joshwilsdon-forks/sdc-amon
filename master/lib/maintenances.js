/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Amon Master model and API endpoints for maintenance windows.
 *
 * Relevant reading:
 * - API: https://mo.joyent.com/docs/amon/master/#master-api-maintenance-windows
 * - Design discussions with 'maintenance' in the title:
 *   https://mo.joyent.com/docs/amon/master/design.html
 *
 * Maintenance windows are stored in redis. They have the following fields:
 *
 * - v {Integer} Internal model version number.
 * - user {String} User UUID.
 * - id {Integer} The maint window id for this user. Unique for a user, i.e.
 *    the (user, id) 2-tuple is the unique id for a maintenance window.
 *    This is set on `createMaintenance()`. See 'Maintenance Window Id' below.
 * - start {Integer} Timestamp (milliseconds since epoch) when the maint
 *    window starts.
 * - end {Integer} Timestamp (milliseconds since epoch) when the maint
 *    window ends.
 * - notes {String} Short note on why this maint window. Can be empty.
 * - all {Boolean} [*]
 * - probes {String} Comma-separated set of probe UUIDs to which this maint
 *   applies, if any. [*]
 * - probeGroups {String} Comma-separated set of probe group UUIDs to which
 *   this maint applies, if any. [*]
 * - machines {String} Comma-separated set of machine UUIDs to which this maint
 *   applies, if any. [*]
 *
 * [*] Only ever one of 'all', 'probes', 'probeGroups' or 'machines' is used
 * for a single maintenance window.
 *
 * Layout in redis:
 *
 * - Amon uses redis db 1: `SELECT 1`.
 * - 'maintenanceIds' is a hash with a (lazy) maint id counter for each user.
 *   `HINCRBY maintenanceIds $userUuid 1` to get the next maint id for that
 *   user.
 * - 'maintenancesByEnd' is a sorted set of maintenance ids for all users
 *   sorted by the end time. It is used by the maintenance reaper
 *   to expire maintenance windows.
 * - 'maintenances:$userUuid' is a set of maintenance ids for that user.
 * - 'maintenance:$userUuid:$maintenanceId' is a hash with the maint data.
 *
 * Maintenance Window Id:
 *
 * On first save to redis a maint window is given an integer `id` that is
 * **unique for that user**, i.e. use the (user, id) 2-tuple for uniqueness
 * within a data center. To be unique to the cloud you need
 * (dc-name, user, id).
 */

var p = console.log;
var format = require('util').format;

var assert = require('assert-plus');
var async = require('async');

var utils = require('amon-common').utils,
    objCopy = utils.objCopy,
    boolFromString = utils.boolFromString;
var errors = require('./errors');



//---- globals

var MAINTENANCE_MODEL_VERSION = 1;
var MAX_NOTES_LENGTH = 255;
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var MAX_REAPER_FREQ = 1000;  // 100ms is max frequency of maint expiry reaping



//---- internal support routines

/**
 * Convert a given maintenance window 'start' value to a Date instance.
 */
function dateFromStart(start) {
    var d;
    if (start === 'now') {
        d = new Date();
    } else {
        d = new Date(start);
        if (isNaN(d.getTime())) {
            throw new TypeError(format('invalid "start": "%s"', start));
        }
    }
    return d;
}


/**
 * Convert a given maintenance window 'end' value to a Date instance.
 */
var endPattern = /^([1-9]\d*)([mhd])$/;
function dateFromEnd(end) {
    var d;
    var match = endPattern.exec(end);
    if (match) {
        var num = match[1];
        var type = match[2];
        var t = Date.now();
        switch (type) {
            case 'm':
                t += num * 60 * 1000;
                break;
            case 'h':
                t += num * 60 * 60 * 1000;
                break;
            case 'd':
                t += num * 24 * 60 * 60 * 1000;
                break;
            default:
                break;
        }
        d = new Date(t);
    } else {
        d = new Date(end);
        if (isNaN(d.getTime())) {
            throw new TypeError(format('invalid "end": "%s"', end));
        }
    }
    return d;
}




function isPositiveInteger(s) {
    var n = Number(s);
    return !isNaN(n) && n > 0 && n === Math.floor(n);
}



//---- Maintenance window model

/**
 * Create a maintenance window
 *
 * @param options {Object} including:
 *    - app {App} Required.
 *    - userUuid {String} Required. The user UUID to which this maint belongs.
 *    - start {String|Integer} Required. Timestamp, date string, or 'now'.
 *    - end {String|Integer} Required. Timestamp, date string, or 'N[mhd]'
 *      (minute, hour, day), e.g. '1h' is one hour from now.
 *    - notes {String} Optional [*].
 *    - all {Boolean} Optional [*].
 *    - probes {Array} Optional [*]. Array of probe UUIDs.
 *    - probeGroups {Array} Optional [*]. Array of probe group UUIDs.
 *    - machines {Array} Optional [*]. Array of machine UUIDs.
 *
 *    [*] One of 'all' (true), 'probes', 'probeGroups' or 'machines' must be
 *    specified.
 * @param callback {Function} `function (err, maintenance)`
 *    where `err` is `TypeError` for invalid options or a redis module error
 *    for a redis problem.
 */
function createMaintenance(options, callback) {
    if (!options.app)
        return callback(new TypeError('"options.app" is required'));
    if (!options.userUuid || !UUID_RE.test(options.userUuid))
        return callback(new TypeError('"options.userUuid" (UUID) is required'));
    if (!options.start)
        return callback(new TypeError('"options.start" is required'));
    if (!options.end)
        return callback(new TypeError('"options.end" is required'));
    if (options.notes && options.notes.length > MAX_NOTES_LENGTH)
        return callback(new TypeError(
            '"options.notes" max length is ' + MAX_NOTES_LENGTH));
    var numScopes = 0;
    if (options.all) numScopes++;
    if (options.probes) {
        assert.arrayOfString(options.probes);
        numScopes++;
    }
    if (options.probeGroups) {
        assert.arrayOfString(options.probeGroups);
        numScopes++;
    }
    if (options.machines) {
        assert.arrayOfString(options.machines);
        numScopes++;
    }
    if (numScopes !== 1) {
        return callback(new TypeError(format('exactly one of '
            + '"options.all" (%s), '
            + '"options.probes" (%s), "options.probeGroups" (%s) or '
            + '"options.machines" (%s) must be specified',
            options.all, options.probes, options.probeGroups,
            options.machines)));
    }
    var log = options.app.log;

    // Convert inputs to data format as to be stored in redis.
    var userUuid = options.userUuid;
    var data = {
        user: userUuid,
        start: dateFromStart(options.start).getTime(),
        end: dateFromEnd(options.end).getTime(),
        notes: options.notes,
        all: options.all,
        probes: options.probes && JSON.stringify(options.probes),
        probeGroups: options.probeGroups && JSON.stringify(options.probeGroups),
        machines: options.machines && JSON.stringify(options.machines)
    };
    log.info(data, 'createMaintenance');

    return options.app.getRedisClient(function (cerr, redisClient) {
        if (cerr) {
            log.error(cerr, 'error getting redis client');
            return callback(cerr);
        }
        redisClient.hincrby('maintenanceIds', userUuid, 1,
            function (idErr, id) {
                if (idErr) {
                    return callback(idErr);
                }
                log.trace({id: id, user: userUuid}, 'new maintenance id');
                data.id = id;
                var maintenance;
                try {
                    maintenance = new Maintenance(data, log);
                } catch (invalidErr) {
                    return callback(invalidErr);
                }
                redisClient.multi()
                    .sadd('maintenances:' + userUuid, maintenance.id)
                    .zadd('maintenancesByEnd', maintenance.end,
                        maintenance._key)
                    .hmset(maintenance._key, maintenance.serializeDb())
                    .exec(function (err, replies) {
                        if (err) {
                            log.error(err, 'error saving maintenance to redis');
                            return callback(err);
                        }
                        // may need to reschedule
                        scheduleNextMaintenanceExpiry(options.app);
                        callback(null, maintenance);
                    });
            }
        );
    });
}


/**
 * Delete the given maintenance.
 *
 * Note that this is also callable with a 'fake maintenance' to allow
 * removal of invalid maintenances. A fake maint is an object with just
 * these fields: user, id, _key.
 *
 * @param app
 * @param maint {Maintenance|fake maint}
 * @param callback {Function} `function (err)`
 */
function deleteMaintenance(app, maint, callback) {
    if (!app)
        throw new TypeError('"app" is required');
    if (!maint)
        throw new TypeError('"maint" is required');
    if (!callback)
        throw new TypeError('"callback" is required');
    var log = app.log;
    log.info({maint: maint}, 'deleteMaintenance');

    app.getRedisClient(function (cerr, client) {
        if (cerr) {
            log.error(cerr, 'error getting redis client');
            return callback(cerr);
        }
        client.multi()
            .srem('maintenances:' + maint.user, maint.id)
            .zrem('maintenancesByEnd', maint._key)
            .del(maint._key)
            .exec(function (redisErr, replies) {
                if (redisErr) {
                    //XXX Really should have a retry here, else maint expiry
                    //    is now stopped.
                    return callback(redisErr);
                }
                if (maint.end) {
                    app.handleMaintenanceEnd(maint, function (endErr) {
                        // may need to resched
                        scheduleNextMaintenanceExpiry(app);
                        if (endErr) {
                            log.error({
                                err: endErr,
                                maint: (maint.serializePublic ?
                                        maint.serializePublic() :
                                        maint)
                                }, 'error handling maint end (now deleted)');
                            return callback(endErr);
                        }
                        callback();
                    });
                } else {
                    // This is a fake maint that we're just expunging from the
                    // DB. Re-scheduling of the next maint expiry will be
                    // handled by the caller.
                    callback();
                }
            }
        );
    });
}


/**
 * List maintenances (get all maintenance windows for the given user).
 *
 * @param all
 * @param userUuid
 * @param log
 * @param callback {Function} `function (err, maintenances)`
 *
 * TODO:XXX cache this. Called frequent for `isEventInMaintenance` usage.
 */
function listMaintenances(app, userUuid, log, callback) {
    if (!app)
        throw new TypeError('"app" is required');
    if (!userUuid)
        throw new TypeError('"userUuid" is required');
    if (!log)
        throw new TypeError('"log" is required');
    if (!callback)
        throw new TypeError('"callback" is required');

    function maintenanceFromId(id, cb) {
        Maintenance.get(app, userUuid, id, cb);
    }

    var setKey = 'maintenances:' + userUuid;
    log.debug('get "%s" smembers', setKey);
    app.getRedisClient(function (cerr, redisClient) {
        if (cerr) {
            log.error(cerr, 'error getting redis client');
            return callback(cerr);
        }
        redisClient.smembers(setKey, function (setErr, maintenanceIds) {
            if (setErr) {
                return callback(setErr);
            }
            log.debug({maintenanceIds: maintenanceIds},
                'get maintenance window data for each key (%d ids)',
                maintenanceIds.length);

            async.map(maintenanceIds, maintenanceFromId,
                                function (getErr, maintenances) {
                if (getErr) {
                    log.error({err: getErr, maintenanceIds: maintenanceIds},
                        'redis error getting maintenance window data');
                    return callback(getErr);
                }

                var filtered = [];
                for (var i = 0; i < maintenances.length; i++) {
                    var a = maintenances[i];
                    if (maintenances[i]) {
                        // Maintenance.get returns a null or undefined
                        // for invalid data.
                        filtered.push(a);
                    }
                }
                maintenances = filtered;

                callback(null, maintenances);
            });
        });
    });
}


/**
 * Construct a maintenance window object from redis data.
 *
 * @param data {Object} The maintenance window data in the format as
 *    retrieved from redis.
 *    See `createMaintenance` for details on data fields. Note that these
 *    are the raw fields, e.g. `start` and `end` are strictly timestamps here.
 * @param log {Bunyan Logger} Required.
 * @throws {TypeError} if the data is invalid.
 */
function Maintenance(data, log) {
    if (!data)
        throw new TypeError('"data" (object) is required');
    if (!data.id || !isPositiveInteger(data.id))
        throw TypeError('"data.id" (integer) is required');
    if (!data.user || !UUID_RE.test(data.user))
        throw new TypeError('"data.user" (UUID) is required');
    if (!data.start || !isPositiveInteger(data.start))
        throw TypeError('"data.start" (timestamp) is required');
    if (!data.end || !isPositiveInteger(data.end))
        throw TypeError('"data.end" (timestamp) is required');
    var numScopes = 0;
    if (data.all) numScopes++;
    if (data.probes) numScopes++;
    if (data.probeGroups) numScopes++;
    if (data.machines) numScopes++;
    if (numScopes !== 1) {
        throw TypeError(format('exactly one of "data.all" (%s), '
            + '"data.probes" (%s), "data.probeGroups (%s)" or '
            + '"data.machines" (%s) must be specified',
            data.all, data.probes, data.probeGroups,
            data.machines));
    }
    if (!log)
        throw new TypeError('"log" (Bunyan Logger) is required');

    this.v = MAINTENANCE_MODEL_VERSION;
    this.user = data.user;
    this.id = Number(data.id);
    this._key = Maintenance.key(this.user, this.id);
    this.log = log.child({maintenance: this.user + ':' + this.id}, true);
    this.start = Number(data.start);
    this.end = Number(data.end);
    this.notes = data.notes;
    this.all = boolFromString(data.all, false, 'data.all');
    this.probes = data.probes && JSON.parse(data.probes);
    this.probeGroups = data.probeGroups && JSON.parse(data.probeGroups);
    this.machines = data.machines && JSON.parse(data.machines);
}


Maintenance.key = function key(userUuid, id) {
    return ['maintenance', userUuid, id].join(':');
};


/**
 * Get a maintenance window from the DB.
 *
 * @param app {App} The master app (holds the redis client).
 * @param userUuid {String} The user UUID.
 * @param id {Integer} The maintenance id.
 * @param callback {Function} `function (err, maintenance)`. Note that the
 *    maintenance and err might *both be null* if there was no error in
 *    retrieving, but the maintenance window data in redis was invalid
 *    (i.e. can't be handled by the constructor).
 */
Maintenance.get = function get(app, userUuid, id, callback) {
    if (!app)
        throw new TypeError('"app" is required');
    if (!userUuid)
        throw new TypeError('"userUuid" (UUID) is required');
    if (!id)
        throw new TypeError('"id" (Integer) is required');
    if (!callback)
        throw new TypeError('"callback" (Function) is required');

    var log = app.log;
    var maintenanceKey = ['maintenance', userUuid, id].join(':');

    app.getRedisClient(function (cerr, client) {
        if (cerr) {
            log.error(cerr, 'error getting redis client');
            return callback(cerr);
        }
        client.multi()
            .hgetall(maintenanceKey)
            .exec(function (err, replies) {
                if (err) {
                    log.error(err, 'error retrieving "%s" data from redis',
                        maintenanceKey);
                    return callback(err);
                }
                var data = replies[0];
                var rErr = app.assertRedisObject(data);
                if (rErr) {
                    return callback(err);
                }
                var maintenance = null;
                try {
                    maintenance = new Maintenance(data, log);
                } catch (invalidErr) {
                    log.warn({err: invalidErr, data: data,
                        maintenanceKey: maintenanceKey},
                        'invalid maintenance window data in redis (removing ' +
                        'this maintenance window)');
                }
                if (!maintenance) {
                    // Remove a bogus maintenance. This is necessary to avoid an
                    // infinite loop in the maintenance expiry reaper's
                    // continued use of a bogus maint in `maintenancesByEnd`.
                    var fakeMaint = {  // enough for `deleteMaintenance` to work
                        user: userUuid,
                        id: id,
                        _key: maintenanceKey
                    };
                    deleteMaintenance(app, fakeMaint, function (delErr) {
                        if (delErr)
                            log.error(delErr, 'could not delete invalid maint');
                        callback(delErr, null);
                    });
                } else {
                    callback(null, maintenance);
                }
            });
    });
};


/**
 * Serialize this Maintenance to a simple object for the public API endpoints.
 */
Maintenance.prototype.serializePublic = function serializePublic() {
    var data = {
        user: this.user,
        id: this.id,
        start: this.start,
        end: this.end
    };
    if (this.notes) data.notes = this.notes;
    if (this.all) data.all = this.all;
    if (this.probes) data.probes = this.probes;
    if (this.probeGroups) data.probeGroups = this.probeGroups;
    if (this.machines) data.machines = this.machines;
    return data;
};

/**
 * Serialize this Maintenance to a simple object for *redis*. This
 * serialization is a superset of `serializePublic`.
 */
Maintenance.prototype.serializeDb = function serializeDb() {
    var obj = this.serializePublic();
    if (obj.probes) obj.probes = JSON.stringify(obj.probes);
    if (obj.probeGroups) obj.probeGroups = JSON.stringify(obj.probeGroups);
    if (obj.machines) obj.machines = JSON.stringify(obj.machines);
    obj.v = this.v;
    return obj;
};



//---- /maintenances/... endpoint handlers

/**
 * Internal API to list/search all maintenance windows.
 *
 * See: <https://mo.joyent.com/docs/amon/master/#ListAllMaintenanceWindows>
 */
function apiListAllMaintenanceWindows(req, res, next) {
    var log = req.log;
    var i;

    log.debug('get all maintenance keys');
    req._app.getRedisClient(function (cerr, redisClient) {
        if (cerr) {
            log.error(cerr, 'error getting redis client');
            return next(cerr);
        }
        redisClient.zrange('maintenancesByEnd', 0, -1,
          function (keysErr, keys) {
            if (keysErr) {
                return next(keysErr);
            }
            log.debug('get maintenance window data for each key (%d keys)',
                keys.length);
            function maintenanceFromKey(maintKey, cb) {
                var bits = maintKey.split(':');
                Maintenance.get(req._app, bits[1], bits[2], cb);
            }
            async.map(keys, maintenanceFromKey,
              function (getErr, maintenances) {
                if (getErr) {
                    log.error({err: getErr, maintenanceKeys: keys},
                        'redis error getting maintenance window data');
                    return next(getErr);
                }
                var serialized = [];
                for (i = 0; i < maintenances.length; i++) {
                    if (maintenances[i] === null) {
                        // Maintenance.get returns a null maintenance window
                        // for invalid data.
                        return false;
                    }
                    serialized.push(maintenances[i].serializeDb());
                }
                res.send(serialized);
                next();
            });
        });
    });
}


/**
 * List a user's maintenance windows.
 *
 * See: <https://mo.joyent.com/docs/amon/master/#ListMaintenanceWindows>
 */
function apiListMaintenanceWindows(req, res, next) {
    var log = req.log;
    var userUuid = req._user.uuid;

    listMaintenances(req._app, userUuid, log, function (listErr, maintenances) {
        if (listErr) {
            log.error(listErr);
            return next(new errors.InternalError(
                'unexpected error getting maintenances for user ' + userUuid));
        }
        var serialized = [];
        for (var i = 0; i < maintenances.length; i++) {
            serialized.push(maintenances[i].serializePublic());
        }
        res.send(serialized);
        next();
    });
}


/**
 * Create a maintenance window.
 *
 * See: <https://mo.joyent.com/docs/amon/master/#CreateMaintenanceWindow>
 */
function apiCreateMaintenanceWindow(req, res, next) {
    var log = req.log;
    var options = objCopy(req.body);
    options.userUuid = req._user.uuid;
    options.app = req._app;

    createMaintenance(options, function (createErr, maintenance) {
        if (createErr) {
            if (createErr.name === 'TypeError') {
                // TODO change to `errors.InvalidParameterError`.
                return next(new errors.InvalidArgumentError(
                    createErr.toString()));
            } else {
                return next(createErr, new errors.InternalError(
                    'unexpected error creating maintenance'));
            }
        }
        var serialized = maintenance.serializePublic();
        log.trace({serialized: serialized}, 'maintenance window created');
        res.send(serialized);
        next();
    });
}

/**
 * Restify handler to add `req._maintenance` or respond with an appropriate
 * error.
 *
 * This is for endpoints at or under '/pub/:user/maintenances/:maintenance'.
 */
function reqGetMaintenanceWindow(req, res, next) {
    var log = req.log;

    // Validate inputs.
    var userUuid = req._user.uuid;
    var id = Number(req.params.maintenance);
    if (!isPositiveInteger(id)) {
        return next(new errors.InvalidArgumentError(
            'invalid "maintenance" id: %j (must be an integer greater than 0)',
            req.params.maintenance));
    }

    log.debug({userUuid: userUuid, maintenanceId: id}, 'get maint window');
    Maintenance.get(req._app, userUuid, id, function (getErr, maintenance) {
        if (getErr) {
            return next(new errors.InternalError(getErr,
                'error getting maintenance window data'));
        } else if (maintenance) {
            req._maintenance = maintenance;
            next();
        } else {
            log.debug('get curr maintenance window id for user "%s" to ' +
                'disambiguate 404 and 410', userUuid);
            req._app.getRedisClient(function (cerr, client) {
                if (cerr) {
                    log.error(cerr, 'error getting redis client');
                    return next(cerr);
                }
                client.hget('maintenanceIds', userUuid,
                    function (idErr, currId) {
                        if (idErr) {
                            // XXX translate node_redis error
                            return next(idErr);
                        }
                        currId = Number(currId) || 0;
                        if (id <= currId) {
                            return next(new errors.GoneError(format(
                                'maint window %d was previously deleted', id)));
                        } else {
                            return next(new errors.ResourceNotFoundError(
                                'maint window %d not found', id));
                        }
                    }
                );
            });
        }
    });
}


/**
 * Get a particular user's maintenance window.
 * See: <https://mo.joyent.com/docs/amon/master/#GetMaintenanceWindow>
 */
function apiGetMaintenanceWindow(req, res, next) {
    res.send(req._maintenance.serializePublic());
    next();
}



/**
 * Delete a given maintenance window.
 *
 * See: <https://mo.joyent.com/docs/amon/master/#DeleteMaintenanceWindow>
 */
function apiDeleteMaintenanceWindow(req, res, next) {
    deleteMaintenance(req._app, req._maintenance, function (err) {
        if (err) {
            return next(new errors.InternalError(err,
                'error deleting maintenance window'));
        }
        res.send(204);
        next();
    });
}


/**
 * Mount API endpoints
 *
 * @param server {restify.Server}
 */
function mountApi(server) {
    server.get({path: '/maintenances',
                            name: 'ListAllMaintenanceWindows'},
        apiListAllMaintenanceWindows);
    server.get({path: '/pub/:user/maintenances',
                            name: 'ListMaintenanceWindows'},
        apiListMaintenanceWindows);
    server.get({path: '/pub/:user/maintenances/:maintenance',
                            name: 'GetMaintenanceWindow'},
        reqGetMaintenanceWindow,  // add `req._maintenance`
        apiGetMaintenanceWindow);
    server.post({path: '/pub/:user/maintenances',
                             name: 'CreateMaintenanceWindow'},
        apiCreateMaintenanceWindow);
    server.del({path: '/pub/:user/maintenances/:maintenance',
                            name: 'DeleteMaintenanceWindow'},
        reqGetMaintenanceWindow,  // add `req._maintenance`
        apiDeleteMaintenanceWindow);
}



//---- reaper/expirer

var expiryTimeout;

/**
 * Schedule a timeout to expire the next (and subsequent) maintenance
 * window timeouts. There is no return or callback for this function.
 *
 * While there are maintenances remaining, this function worries about
 * re-scheduling itself for subsequent expiries. However, this function
 * must be called:
 * - on app startup to get the ball rolling
 * - on add/update/delete of maintenance windows to re-schedule if necessary
 *
 * @param app {App}
 */
function scheduleNextMaintenanceExpiry(app) {
    var log = app.log.child({component: 'maintexpiry'}, true);

    if (expiryTimeout) {
        log.info('clear existing maintenance expiryTimeout');
        clearTimeout(expiryTimeout);
    }

    function rescheduleLater() {
        log.info('Re-schedule maintenance reaper to start again in 5 minutes.');
        setTimeout(function () {
            scheduleNextMaintenanceExpiry(app);
        }, 5 * 60 * 1000);
    }

    app.getRedisClient(function (cerr, redisClient) {
        if (cerr) {
            log.error(cerr, 'error getting redis client');
            return;
        }
        redisClient.zrange('maintenancesByEnd', 0, 0, 'WITHSCORES',
                                             function (err, nextMaint) {
            if (err) {
                // It is bad if maintenance expiry tanks, so we'll log an error
                // (i.e. we expect an operator to take a look at some point) and
                // reschedule for a few minutes from now.
                log.error(err,
                    'Error finding next maintenance window to expire.');
                rescheduleLater();
            } else if (nextMaint.length === 0) {
                log.info('no current maintenance windows');
            } else {
                var maintRepr = nextMaint[0];
                var maintenanceEnd = nextMaint[1];
                var expiresIn = maintenanceEnd - Date.now();
                // Guard against a too-small `expiresIn`. An accidental
                // negative number is hard loop.
                expiresIn = Math.max(MAX_REAPER_FREQ, expiresIn);
                log.info({maintenanceEnd: new Date(maintenanceEnd),
                    expiresIn: expiresIn, maintRepr: maintRepr},
                    'set maintenance expiryTimeout');
                expiryTimeout = setTimeout(function () {
                    var userUuid = maintRepr.split(':')[1];
                    var id = maintRepr.split(':')[2];
                    Maintenance.get(app, userUuid, id,
                      function (getErr, maint) {
                        if (getErr) {
                            log.error({err: getErr, userUuid: userUuid, id: id},
                            'error getting maint to expire in expiryTimeout');
                            rescheduleLater();
                        } else if (!maint) {
                            log.info({userUuid: userUuid, id: id},
                                'maint to expire no longer exists');
                            scheduleNextMaintenanceExpiry(app);
                        } else {
                            log.info({maint: maint.serializePublic()},
                                'expire maint');
                            deleteMaintenance(app, maint, function (delErr) {
                                if (delErr) {
                                    log.error({err: delErr,
                                        maintRepr: maintRepr}, 'error ' +
                                        'deleting maint in expiryTimeout');
                                }
                                scheduleNextMaintenanceExpiry(app);
                            });
                        }
                    });
                }, expiresIn);
            }
        });
    });
}



//---- other exported methods

/**
 * Determine if the given event is affected by a current maintenance window.
 *
 * Dev Note: This is O(N) on the number of maintenance windows for that
 * user and is on the hot path: called for each event. IOW, this could
 * theoretically be improved, but the expectation is that a particular
 * user won't have lots of maintenance windows.
 *
 * @param options {Object} with:
 *    - @param app {App} Required.
 *    - @param event {event Object} Required.
 *    - @param log {Bunyan Logger} Optional.
 *    - @param probe {probes.Probe} If the event is associated with a specific
 *      probe.
 *    - @param probeGroup {probegroups.ProbeGroup} If the event is associated
 *      with a specific probe group.
 * @param callback {Function} `function (err, maint)` where maint is null
 *    if not in maintenance, and is a Maintenace instance if in maint. Note
 *    that an event might be affected by multiple maintenance windows. This
 *    does not return all relevant maintenance windows.
 */
function isEventInMaintenance(options, callback) {
    if (!options)
        throw new TypeError('"options" is required');
    if (!options.app)
        throw new TypeError('"options.app" is required');
    if (!options.event)
        throw new TypeError('"options.event" is required');
    if (!callback)
        throw new TypeError('"callback" is required');
    var event = options.event;
    var log = options.log || options.app.log;

    var etime = event.time;
    var eprobe = event.probeUuid; // Note: not all events have a `probe`
    var eprobeGroup = options.probeGroup && options.probeGroup.uuid;
    var emachine = event.machine; // Note: not all events have a `machine`
    log.debug({etime: etime, eprobe: eprobe, emachine: emachine},
        'isEventInMaintenance');
    listMaintenances(options.app, event.user, log,
                                     function (listErr, maintenances) {
        if (listErr) {
            return callback(listErr);
        }
        log.debug({num_maints: maintenances.length},
            'isEventInMaintenance: maintenances to consider');
        for (var i = 0; i < maintenances.length; i++) {
            var m = maintenances[i];
            log.trace({maint: m}, 'isEventInMaintenance: consider this maint');
            if (etime <= m.start || m.end <= etime) {
                log.trace({maint_id: m.id},
                    'isEventInMaintenance: no (maint expired)');
                continue;  // inactive maintenance window
            } else if (m.all) {
                log.debug({maint_id: m.id, all: true},
                    'isEventInMaintenance: yes (all)');
                return callback(null, m);
            } else if (m.probeGroups && eprobeGroup) {
                if (m.probeGroups.indexOf(eprobeGroup) !== -1) {
                    log.debug({maint_id: m.id, probeGroup: eprobeGroup},
                        'isEventInMaintenance: yes (probeGroup)');
                    return callback(null, m);
                } else {
                    log.trace({maint_id: m.id, probe: eprobeGroup},
                        'isEventInMaintenance: no (not a matching probeGroup)');
                }
            } else if (m.probes && eprobe) {
                if (m.probes.indexOf(eprobe) !== -1) {
                    log.debug({maint_id: m.id, probe: eprobe},
                        'isEventInMaintenance: yes (probe)');
                    return callback(null, m);
                } else {
                    log.trace({maint_id: m.id, probe: eprobe},
                        'isEventInMaintenance: no (not a matching probe)');
                }
            } else if (m.machines && emachine) {
                if (m.machines.indexOf(emachine) !== -1) {
                    log.debug({maint_id: m.id, machine: emachine},
                        'isEventInMaintenance: yes (machine)');
                    return callback(null, m);
                } else {
                    log.trace({maint_id: m.id, machine: emachine},
                        'isEventInMaintenance: no (not a matching machine)');
                }
            }
        }
        callback(null, null);
    });
}



//---- exports

module.exports = {
    Maintenance: Maintenance,
    MAINTENANCE_MODEL_VERSION: MAINTENANCE_MODEL_VERSION,
    scheduleNextMaintenanceExpiry: scheduleNextMaintenanceExpiry,
    isEventInMaintenance: isEventInMaintenance,

    mountApi: mountApi
};
