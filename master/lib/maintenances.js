/*
 * Copyright 2012 Joyent, Inc.  All rights reserved.
 *
 * Amon Master model and API endpoints for maintenance windows.
 *
 * Relevant reading:
 * - API: https://mo.joyent.com/docs/amon/master/#master-api-maintenance-windows
 * - Design discussions with "maintenance" in the title:
 *   https://mo.joyent.com/docs/amon/master/design.html
 *
 * Maintenance windows are stored in redis. They have the following fields:
 *
 * - v {Integer} Internal model version number.
 * - user {String} User UUID.
 * - id {Integer} The maint window id for this user. Unique for a user, i.e.
 *    the (user, id) 2-tuple is the unique id for a maintenance window.
 *    This is set on `createMaintenance()`. See "Maintenance Window Id" below.
 * - start {Integer} Timestamp (milliseconds since epoch) when the maint
 *    window starts.
 * - end {Integer} Timestamp (milliseconds since epoch) when the maint
 *    window ends.
 * - notes {String} Short note on why this maint window. Can be empty.
 * - all {Boolean}
 * - monitors {String} Comma-separated set of monitor names to which this maint
 *    applies, if any.
 * - machines {String} Comma-separated set of machine UUIDs to which this maint
 *    applies, if any.
 *
 * Layout in redis:
 * - Amon uses redis db 1: `SELECT 1`.
 * - 'maintenances:$userUuid' is a set of maintenance ids for that user.
 * - 'maintenance:$userUuid:$maintenanceId' is a hash with the maint data.
 * - 'maintenanceIds' is a hash with a (lazy) maint id counter for each user.
 *   `HINCRBY maintenanceIds $userUuid 1` to get the next maint id for that
 *   user.
 *
 * Maintenance Window Id:
 *
 * On first save to redis a maint window is given an integer `id` that is
 * **unique for that user**, i.e. use the (user, id) 2-tuple for uniqueness
 * within a data center. To be unique to the cloud you need
 * (dc-name, user, id).
 */

var format = require('util').format;
var assert = require('assert');

var restify = require('restify');
var async = require('async');

var amonCommon = require('amon-common'),
  objCopy = amonCommon.utils.objCopy;



//---- globals

var MAINTENANCE_MODEL_VERSION = 1;
var MAX_NOTES_LENGTH = 255;
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;



//---- internal support routines

/**
 * Convert a boolean or redis string representing a boolean into a
 * boolean, or raise TypeError trying.
 *
 * @param value {Boolean|String} The input value to convert.
 * @param default_ {Boolean} The default value is `value` is undefined.
 * @param errName {String} The variable name to quote in the possibly
 *    raised TypeError.
 */
function boolFromRedisString(value, default_, errName) {
  if (value === undefined) {
    return default_;
  } else if (value === 'false') { // redis hash string
    return false;
  } else if (value === 'true') { // redis hash string
    return true;
  } else if (typeof (value) === 'boolean') {
    return value;
  } else {
    throw new TypeError(
      format('invalid value for "%s": %j', errName, value));
  }
}


/**
 * Convert a given maintenance window "start" value to a Date instance.
 */
function dateFromStart(start) {
  var d;
  if (start === "now") {
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
 * Convert a given maintenance window "end" value to a Date instance.
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


/**
 * Parse a CSV row (i.e. a single row) into an array of strings.
 *
 * c.f. http://en.wikipedia.org/wiki/Comma-separated_values
 *
 * I didn't use one of the existing node CSV modules (bad me) because the
 * few I looked at were all async APIs.
 *
 * Limitations/Opinions:
 * - untested
 * - don't support elements with line-breaks
 * - leading a trailing spaces are trimmed, unless the entry is quoted
 *
 * @throws {TypeError} if the given CSV row is invalid
 */
function parseCSVRow(s) {
  var DEBUG = true;
  var row = [];
  var i = 0;
  var ch;

  if (s.indexOf('\n') !== -1 || s.indexOf('\r') !== -1) {
    throw new TypeError(
      format('illegal char: newlines not supported: "%s"', s));
  }

  DEBUG && console.warn('--\ns: %j', s);
  while (i < s.length) {
    DEBUG && console.warn('start cell');
    var cell = [];
    var quoted = false;
    var iQuote;

    // Find first non-whitespace cell char.
    while (i < s.length) {
      var ch = s[i];
      if (ch === ' ' || ch === '\t') {
        cell.push(ch);
      } else if (ch === '"') {
        quoted = true;
        iQuote = i;
        cell = [ch]; // wipe out leading whitespace
        i++;
        break;
      } else if (ch === ',') {
        // Empty cell.
        break;
      } else {
        cell.push(ch);
        i++;
        break;
      }
      i++;
    }
    DEBUG && console.warn('after first non-ws char: cell=%j, quoted=%j, i=%j', cell, quoted, i);

    if (quoted) {
      // Slurp up until end of string or close-quote.
      while (true) {
        if (i >= s.length) {
          throw new TypeError(format(
            "unterminated quoted string starting at position %d: '%s'",
            iQuote, s));
        }
        var ch = s[i];
        cell.push(ch);
        if (ch === '"') {
          if (i + 1 < s.length && s[i + 1] === '"') {
            // Escaped quote.
            i++;
          } else {
            // End of quoted string.
            i++;
            break;
          }
        }
        i++;
      }

      // Advance to comma (or end of string).
      while (i < s.length) {
        var ch = s[i];
        if (ch === ',') {
          i++;
          break;
        } else if (ch !== ' ' && ch !== '\t') {
          throw new TypeError(format(
            "illegal char outside of quoted cell at position %d: '%s'",
            i, s));
        }
        i++;
      }
    } else {
      // Slurp up cell until end of string or comma.
      while (i < s.length) {
        var ch = s[i];
        if (ch === ',') {
          i++;
          break;
        } else if (ch === '"') {
          throw new TypeError(
            format("illegal double-quote at position %d: '%s'", i, s));
        } else {
          cell.push(ch);
        }
        i++;
      }
    }

    // Post-process cell.
    if (quoted) {
      cell = cell.slice(1, cell.length - 1); // drop the quotes
      cell = cell.join('');
    } else {
      cell = cell.join('').trim();
    }
    DEBUG && console.warn('cell: cell=%j i=%j', cell, i);
    row.push(cell);
  }

  // Special case for trailing ','.
  if (s[s.length - 1] === ',') {
    DEBUG && console.warn('special case: add cell for trailing comma');
    row.push('');
  }

  DEBUG && console.warn('return: %j\n', row);
  return row;
}

/**
 * Serialize the given array to a CSV row.
 */
function serializeCSVRow(a) {
  var row = [];
  for (var i = 0; i < a.length; i++) {
    var elem = a[i];
    if (elem.indexOf(' ') !== -1 || elem.indexOf('\t') !== -1 ||
        elem.indexOf(',') !== -1 || elem.indexOf('"') !== -1) {
      row.push('"' + elem.replace(/"/g, '""') + '"')
    }
  }
  return row.join(',');
}

/**
 * Normalize the given CSV line.
 */
function normalizeCSVRow(s) {
  var row = parseCSVRow(s);
  var noEmpties = row.filter(function (elem) { return !!elem });
  return serializeCSVRow(noEmpties);
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
 *    - start {String|Integer} Required. Timestamp, date string, or "now".
 *    - end {String|Integer} Required. Timestamp, date string, or "N[mhd]"
 *      (minute, hour, day), e.g. "1h" is one hour from now.
 *    - notes {String} Optional.
 *    - all {Boolean} Optional.
 *    - monitors {String} Optional. Comma-separated list of monitor names.
 *    - machines {String} Optional. Comma-separated list of machines UUIDs.
 *
 *    One of 'all' (true), 'monitors' or 'machines' must be specified.
 * @param callback {Function} `function (err, maintenance)`
 *    where `err` is `TypeError` for invalid options or a redis module error
 *    for a redis problem.
 */
function createMaintenance(options, callback) {
  if (!options) return callback(new TypeError('"options" is required'));
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
  if (options.monitors) numScopes++;
  if (options.machines) numScopes++;
  if (numScopes !== 1) {
    return callback(new TypeError(format('only one of "options.all" (%s), ' +
      '"options.monitors" (%s) or "options.machines" (%s) may be specified',
      options.all, options.monitors, options.machines)));
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
    monitors: options.monitors && normalizeCSVRow(options.monitors),
    machines: options.machines && normalizeCSVRow(options.machines)
  };
  log.info(data, 'createMaintenance');

  var redisClient = options.app.getRedisClient();
  return redisClient.hincrby('maintenanceIds', userUuid, 1, function (idErr, id) {
    if (idErr) {
      return callback(idErr);
    }
    log.trace({id: id, user: userUuid}, 'new maintenance id');
    data.id = id;
    try {
      var maintenance = new Maintenance(data, log);
    } catch (invalidErr) {
      return callback(invalidErr);
    }
    redisClient.multi()
      .sadd('maintenances:' + userUuid, maintenance.id)
      .hmset(maintenance._key, maintenance.serializeDb())
      .exec(function (err, replies) {
        if (err) {
          log.error(err, 'error saving maintenance to redis');
          return callback(err);
        }
        callback(null, maintenance);
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
  if (!data) throw new TypeError('"data" (object) is required');
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
  if (data.monitors) numScopes++;
  if (data.machines) numScopes++;
  if (numScopes !== 1) {
    throw TypeError(format('exactly one of "data.all" (%s), ' +
      '"data.monitors" (%s) or "data.machines" (%s) must be specified',
      data.all, data.monitors, data.machines));
  }
  if (!log) throw new TypeError('"log" (Bunyan Logger) is required');

  this.v = MAINTENANCE_MODEL_VERSION;
  this.user = data.user;
  this.id = Number(data.id);
  this._key = ['maintenance', this.user, this.id].join(':');
  this.log = log.child({maintenance: this.user + ':' + this.id}, true);
  this.start = Number(data.start);
  this.end = Number(data.end);
  this.notes = data.notes;
  this.all = boolFromRedisString(data.all, false, 'data.all');
  this.monitors = data.monitors;
  this.machines = data.machines;
}


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
  if (!app) throw new TypeError('"app" is required');
  if (!userUuid) throw new TypeError('"userUuid" (UUID) is required');
  if (!id) throw new TypeError('"id" (Integer) is required');
  if (!callback) throw new TypeError('"callback" (Function) is required');

  var log = app.log;
  var maintenanceKey = ['maintenance', userUuid, id].join(':');

  app.getRedisClient().multi()
    .hgetall(maintenanceKey)
    .exec(function (err, replies) {
      if (err) {
        log.error(err, 'error retrieving "%s" data from redis', maintenanceKey);
        return callback(err);
      }
      var data = replies[0];
      var maintenance = null;
      try {
        maintenance = new Maintenance(data, log);
      } catch (invalidErr) {
        log.warn({err: invalidErr, data: data},
          'invalid maintenance window data in redis (ignoring this ' +
          'maintenance window)');
      }
      callback(null, maintenance);
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
  if (this.monitors) data.monitors = this.monitors;
  if (this.machines) data.machines = this.machines;
  return data;
};

/**
 * Serialize this Maintenance to a simple object for *redis*. This
 * serialization is a superset of `serializePublic`.
 */
Maintenance.prototype.serializeDb = function serializeDb() {
  var obj = this.serializePublic();
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
  var redisClient = req._app.getRedisClient();

  log.debug('get "maintenance:*" keys');
  redisClient.keys('maintenance:*', function (keysErr, maintenanceKeys) {
    if (keysErr) {
      return next(keysErr);
    }
    log.debug('get maintenance window data for each key (%d keys)',
      maintenanceKeys.length);
    function maintenanceFromKey(key, cb) {
      var bits = key.split(':');
      Maintenance.get(req._app, bits[1], bits[2], cb);
    }
    async.map(maintenanceKeys, maintenanceFromKey,
              function (getErr, maintenances) {
      if (getErr) {
        log.error({err: getErr, maintenanceKeys: maintenanceKeys},
          'redis error getting maintenance window data');
        return next(getErr);
      }
      var serialized = [];
      for (i = 0; i < maintenances.length; i++) {
        if (maintenances[i] === null) {
          // Maintenance.get returns a null maintenance window for invalid data.
          return false;
        }
        serialized.push(maintenances[i].serializeDb());
      }
      res.send(serialized);
      next();
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
  var i, a;
  var userUuid = req._user.uuid;

  function maintenanceObjFromId(id, cb) {
    var key = format('maintenance:%s:%s', userUuid, id);
    redisClient.hgetall(key, cb);
  }
  function maintenanceFromId(id, cb) {
    Maintenance.get(req._app, userUuid, id, cb);
  }

  var setKey = 'maintenances:' + userUuid;
  log.debug('get "%s" smembers', setKey);
  var redisClient = req._app.getRedisClient();
  redisClient.smembers(setKey, function (setErr, maintenanceIds) {
    if (setErr) {
      return next(setErr);
    }
    log.debug({maintenanceIds: maintenanceIds},
      'get maintenance window data for each key (%d ids)',
      maintenanceIds.length);

    async.map(maintenanceIds, maintenanceFromId,
              function (getErr, maintenances) {
      if (getErr) {
        log.error({err: getErr, maintenanceIds: maintenanceIds},
          'redis error getting maintenance window data');
        return next(getErr);
      }

      var filtered = [];
      for (i = 0; i < maintenances.length; i++) {
        a = maintenances[i];
        if (maintenances[i] != null) {
          // Maintenance.get returns a null maintenance for invalid data.
          filtered.push(a);
        }
      }
      maintenances = filtered;

      var serialized = [];
      for (i = 0; i < maintenances.length; i++) {
        serialized.push(maintenances[i].serializePublic());
      }
      res.send(serialized);
      next();
    });
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
        return next(new restify.InvalidArgumentError(createErr.toString()));
      } else {
        log.error(createErr);
        return next(new restify.InternalError(
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
    return next(new restify.InvalidArgumentError(
      'invalid "maintenance" id: %j (must be an integer greater than 0)',
      req.params.maintenance));
  }

  log.debug({userUuid: userUuid, maintenanceId: id}, 'get maintenance window');
  Maintenance.get(req._app, userUuid, id, function (getErr, maintenance) {
    if (getErr) {
      log.error(getErr);
      return next(new restify.InternalError(
        'error getting maintenance window data'));
    } else if (maintenance) {
      req._maintenance = maintenance;
      next();
    } else {
      log.debug('get curr maintenance window id for user "%s" to ' +
        'disambiguate 404 and 410', userUuid);
      req._app.getRedisClient().hget('maintenanceIds', userUuid,
                                     function (idErr, currId) {
        if (idErr) {
          return next(idErr);  // XXX translate node_redis error
        }
        currId = Number(currId) || 0;
        if (id <= currId) {
          return next(new restify.GoneError(
            format('maintenance window %d was previously deleted', id)));
        } else {
          return next(new restify.ResourceNotFoundError(
            'maintenance window %d not found', id));
        }
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
  var userUuid = req._user.uuid;
  var maintenance = req._maintenance;

  var multi = req._app.getRedisClient().multi();
  multi.srem('maintenances:' + userUuid, maintenance.id);
  multi.del(maintenance._key);
  multi.exec(function (redisErr, replies) {
    if (redisErr) {
      log.error(redisErr);
      return next(new restify.InternalError(
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
  server.get({path: '/maintenances', name: 'ListAllMaintenanceWindows'},
    apiListAllMaintenanceWindows);
  server.get({path: '/pub/:user/maintenances', name: 'ListMaintenanceWindows'},
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



//---- exports

module.exports = {
  Maintenance: Maintenance,
  MAINTENANCE_MODEL_VERSION: MAINTENANCE_MODEL_VERSION,
  createMaintenance: createMaintenance,
  mountApi: mountApi,

  // Only exported to test it.
  parseCSVRow: parseCSVRow
};