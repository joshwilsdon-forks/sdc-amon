/*
 * Copyright 2011 Joyent, Inc.  All rights reserved.
 *
 * The Amon Master app. It defines the master API endpoints.
 */

var http = require('http');
var assert = require('assert');
var debug = console.log;

var ldap = require('ldapjs');
var restify = require('restify');
var sprintf = require('sprintf').sprintf;

var amonCommon = require('amon-common');
var Cache = amonCommon.Cache;
var Constants = amonCommon.Constants;
var Contact = require('./contact');

// Endpoint controller modules.
var monitors = require('./monitors');
var Monitor = monitors.Monitor;
var probes = require('./probes');
var agentprobes = require('./agentprobes');
var events = require('./events');



//---- globals

var log = restify.log;

var UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Ensure login doesn't have LDAP search meta chars.
// Note: this regex should conform to `LOGIN_RE` in
// <https://mo.joyent.com/ufds/blob/master/schema/sdcperson.js>.
var VALID_LOGIN_CHARS = /^[a-zA-Z][a-zA-Z0-9_\.@]+$/;



//---- internal support stuff

function ping(req, res, next) {
  if (req.params.error !== undefined) {
    var restCode = req.params.error || "InternalError";
    if (restCode.slice(-5) !== "Error") {
      restCode += "Error"
    }
    var err = new restify[restCode]("pong");
    res.sendError(err, err instanceof restify.ResourceNotFoundError);
  } else {
    var data = {
      ping: "pong",
      pid: process.pid  // used by test suite
    };
    res.send(200, data);
  }
  return next();
}

// Debugging.
//function listCaches(req, res, next) {
//  var data = req._app._cacheFromScope;
//  var data = {};
//  Object.keys(req._app._cacheFromScope).forEach(function(k) {
//    data[k] = req._app._cacheFromScope[k].getAll()
//  });
//  res.send(200, data);
//  return next();
//}

function getUser(req, res, next) {
  user = req._user;
  var data = {
    login: user.login,
    email: user.email,
    id: user.uuid,
    firstName: user.cn,
    lastName: user.sn
  };
  res.send(200, data);
  return next();
}


/**
 * Run async `fn` on each entry in `list`. Call `cb(error)` when all done.
 * `fn` is expected to have `fn(item, callback) -> callback(error)` signature.
 *
 * From Isaac's rimraf.js.
 */
function asyncForEach(list, fn, cb) {
  if (!list.length) cb()
  var c = list.length
    , errState = null
  list.forEach(function (item, i, list) {
   fn(item, function (er) {
      if (errState) return
      if (er) return cb(errState = er)
      if (-- c === 0) return cb()
    })
  })
}



//---- exports

/**
 * Create the app.
 *
 * @param config {Object} The amon master config object.
 * @param callback {Function} `function (err, app) {...}`.
 */
function createApp(config, callback) {
  var ufds = ldap.createClient({
    url: config.ufds.url
  }); 
  
  var opts;
  opts = {
    filter: '(login=*)',
    scope: 'sub'
  };
  ufds.bind('cn=root', 'secret', function(err) {
    if (err) {
      return callback(err);
    }
    try {
      var app = new App(config, ufds);
    } catch(err) {
      return callback(err);
    }
    return callback(null, app);
  });
}



/**
 * Constructor for the amon "application".
 *
 * @param config {Object} Config object.
 * @param ufds {ldapjs.Client} LDAP client to UFDS.
 */
function App(config, ufds) {
  var self = this;

  if (!config) throw TypeError('config is required');
  if (!config.port) throw TypeError('config.port is required');
  if (!ufds) throw TypeError('ufds is required');
  this.config = config;
  this.ufds = ufds;
  this._ufdsCaching = (config.ufds.caching === undefined
    ? true : config.ufds.caching);

  this.notificationPlugins = {};
  if (config.notificationPlugins) {
    Object.keys(config.notificationPlugins || {}).forEach(function (name) {
      var plugin = config.notificationPlugins[name];
      log.info("Loading '%s' notification plugin.", name);
      var NotificationType = require(plugin.path);
      self.notificationPlugins[name] = new NotificationType(plugin.config);
    });
  }

  // Cache of login/uuid (aka username) -> full user record.
  this.userCache = new Cache(config.userCache.size,
    config.userCache.expiry, log, "user");
  
  // Caches for server response caching. This is centralized on the app
  // because it allows the interdependant cache-invalidation to be
  // centralized.
  this._cacheFromScope = {
    MonitorGet: new Cache(100, 300, log, "MonitorGet"),
    MonitorList: new Cache(100, 300, log, "MonitorList"),
    ProbeGet: new Cache(100, 300, log, "ProbeGet"),
    ProbeList: new Cache(100, 300, log, "ProbeList"),
    // This is unbounded in size because (a) the data stored is small and (b)
    // we expect `headAgentProbes` calls for *all* zones (the key) regularly
    // so an LRU-cache is pointless.
    headAgentProbes: new Cache(0, 300, log, "headAgentProbes"),
  };

  var server = this.server = restify.createServer({
    apiVersion: Constants.ApiVersion,
    serverName: "Amon Master/" + Constants.ApiVersion
  });

  function setup(req, res, next) {
    req._app = self;
    req._ufds = self.ufds;
    req._log = log;

    // Handle ':user' in route: add `req._user` or respond with
    // appropriate error.
    var userId = req.uriParams.user;
    if (userId) {
      self.userFromId(userId, function (err, user) {
        if (err) {
          //TODO: does this work with an LDAPError?
          res.sendError(err, err instanceof restify.ResourceNotFoundError);
        } else if (! user) {
          res.sendError(new restify.ResourceNotFoundError(
            sprintf("no such user: '%s'", userId)), true);
        } else {
          req._user = user;
        }
        return next();
      });
    } else {
      return next();
    }
  };

  var before = [setup];
  var after = [restify.log.w3c];

  server.get('/ping', before, ping, after);
  // Debugging:
  //server.get('/caches', before, listCaches, after);

  server.get('/pub/:user', before, getUser, after);
  
  server.get('/pub/:user/monitors', before, monitors.listMonitors, after);
  server.put('/pub/:user/monitors/:name', before, monitors.putMonitor, after);
  server.get('/pub/:user/monitors/:name', before, monitors.getMonitor, after);
  server.del('/pub/:user/monitors/:name', before, monitors.deleteMonitor, after);
  
  server.get('/pub/:user/monitors/:monitor/probes', before, probes.listProbes, after);
  server.put('/pub/:user/monitors/:monitor/probes/:name', before, probes.putProbe, after);
  server.get('/pub/:user/monitors/:monitor/probes/:name', before, probes.getProbe, after);
  server.del('/pub/:user/monitors/:monitor/probes/:name', before, probes.deleteProbe, after);
  
  server.get('/agentprobes', before, agentprobes.listAgentProbes, after);
  server.head('/agentprobes', before, agentprobes.headAgentProbes, after);
  
  server.post('/events', before, events.addEvents, after);
};


/**
 * Gets Application up and listening.
 *
 * This method creates a zsock with the zone/path you passed in to the
 * constructor.  The callback is of the form function(error), where error
 * should be undefined.
 *
 * @param {Function} callback callback of the form function(error).
 */
App.prototype.listen = function(callback) {
  this.server.listen(this.config.port, '0.0.0.0', callback);
};


App.prototype.cacheGet = function(scope, key) {
  if (! this._ufdsCaching) return;
  var hit = this._cacheFromScope[scope].get(key);
  //log.trace("App.cacheGet scope='%s' key='%s': %s", scope, key,
  //  (hit ? "hit" : "miss"));
  return hit
}
App.prototype.cacheSet = function(scope, key, value) {
  if (! this._ufdsCaching) return;
  //log.trace("App.cacheSet scope='%s' key='%s'", scope, key);
  this._cacheFromScope[scope].set(key, value);
}

/**
 * Invalidate caches as appropriate for the given DB object create/update.
 */
App.prototype.cacheInvalidatePut = function(modelName, item) {
  if (! this._ufdsCaching) return;
  var dn = item.raw.dn;
  assert.ok(dn);
  log.trace("App.cacheInvalidatePut modelName='%s' dn='%s' zone=%s",
    modelName, dn, (modelName === "Probe" ? item.zone : "(N/A)"));

  // Reset the "${modelName}List" cache.
  // Note: This could be improved by only invalidating the item for this
  // specific user. We are being lazy for starters here.
  var scope = modelName + "List"
  this._cacheFromScope[scope].reset();
  
  // Delete the "${modelName}Get" cache item with this dn (possible because
  // we cache error responses).
  this._cacheFromScope[modelName + "Get"].del(dn);
  
  // Furthermore, if this is a probe, then need to invalidate the
  // `headAgentProbes` for this probe's zone.
  if (modelName === "Probe") {
    this._cacheFromScope.headAgentProbes.del(item.zone);
  }
}

/**
 * Invalidate caches as appropriate for the given DB object delete.
 */
App.prototype.cacheInvalidateDelete = function(modelName, item) {
  if (! this._ufdsCaching) return;
  var dn = item.raw.dn;
  assert.ok(dn);
  log.trace("App.cacheInvalidateDelete modelName='%s' dn='%s' zone=%s",
    modelName, dn, (modelName === "Probe" ? item.zone : "(N/A)"));

  // Reset the "${modelName}List" cache.
  // Note: This could be improved by only invalidating the item for this
  // specific user. We are being lazy for starters here.
  var scope = modelName + "List";
  this._cacheFromScope[scope].reset();
  
  // Delete the "${modelName}Get" cache item with this dn.
  this._cacheFromScope[modelName + "Get"].del(dn);
  
  // Furthermore, if this is a probe, then need to invalidate the
  // `headAgentProbes` for this probe's zone.
  if (modelName === "Probe") {
    this._cacheFromScope.headAgentProbes.del(item.zone);
  }
}

/**
 * Facilitate getting user info (and caching it) from a login/username.
 *
 * @param userId {String} UUID or login (aka username) of the user to get.
 * @param callback {Function} `function (err, user)`. "err" is a restify
 *    RESTError instance if there is a problem. "user" is null if no
 *    error, but no such user was found.
 */
App.prototype.userFromId = function(userId, callback) {
  // Validate args.
  if (!userId) {
    log.error("userFromId: 'userId' is required");
    return callback(new restify.InternalError());
  }
  if (!callback || typeof(callback) !== 'function') {
    log.error("userFromId: 'callback' must be a function: %s",
      typeof(callback));
    return callback(new restify.InternalError());
  }
  
  // Check cache. "cached" is `{err: <error>, user: <user>}`.
  var cached = this.userCache.get(userId);
  if (cached) {
    if (cached.err)
      return callback(cached.err);
    return callback(null, cached.user);
  }
  
  // UUID or login?
  var uuid = null, login = null;
  if (UUID_REGEX.test(userId)) {
    uuid = userId;
  } else if (VALID_LOGIN_CHARS.test(login)) {
    login = userId;
  } else {
    return callback(new restify.InvalidArgumentError(
      sprintf("user id is not a valid UUID or login: '%s'", userId)));
  }

  var self = this;
  function cacheAndCallback(err, user) {
    var obj = {err: err, user: user};
    if (user) {
      // On success, cache for both the UUID and login.
      self.userCache.set(user.uuid, obj);
      self.userCache.set(user.login, obj);
    } else {
      self.userCache.set(userId, obj);
    }
    return callback(err, user);
  }

  // Look up the login, cache the result and return.
  var searchOpts = {
    filter: (uuid
      ? '(&(uuid=' + uuid + ')(objectclass=sdcperson))'
      : '(&(login=' + login + ')(objectclass=sdcperson))'),
    scope: 'one'
  };
  this.ufds.search("ou=users, o=smartdc", searchOpts, function(err, result) {
    if (err) return cacheAndCallback(err);

    var users = [];
    result.on('searchEntry', function(entry) {
      users.push(entry.object);
    });

    result.on('error', function(err) {
      // `err` is an ldapjs error (<http://ldapjs.org/errors.html>) which is
      // currently compatible enough so that we don't bother wrapping it in
      // a `restify.RESTError`. (TODO: verify that)
      return cacheAndCallback(err);
    });

    result.on('end', function(result) {
      if (result.status !== 0) {
        return cacheAndCallback("non-zero status from LDAP search: "+result);
      }
      switch (users.length) {
      case 0:
        return cacheAndCallback(null, null);
        break;
      case 1:
        return cacheAndCallback(null, users[0]);
        break;
      default:
        log.error("unexpected number of users (%d) matching user id '%s': "
          + "searchOpts=%o  users=%o", users.length, userId, searchOpts,
          users);
        return cacheAndCallback(new restify.InternalError(
          sprintf("error determining user for '%s'", userId)));
      }
    });
  });
  
};


/**
 * Handle an incoming event.
 *
 * @param ufds {ldapjs client} UFDS client.
 * @param event {Object} The event object.
 * @param callback {Function} `function (err) {}` called on completion.
 *    "err" is undefined (success) or an error message (failure).
 *
 * An example event (beware this being out of date):
 *    {
 *      "probe": {
 *        "user": "7b23ae63-37c9-420e-bb88-8d4bf5e30455",
 *        "monitor": "whistle",
 *        "name": "whistlelog2",
 *        "type": "amon:logscan"
 *      },
 *      "type": "Integer",
 *      "value": 1,
 *      "data": {
 *        "match": "tweet tweet"
 *      },
 *      "uuid": "3ab1336e-5453-45f9-be10-8686ba70e419",
 *      "version": "1.0.0"
 *    }
 *
 * TODO: inability to send a notification should result in an alarm for
 *   the owner of the monitor.
 */
App.prototype.processEvent = function (event, callback) {
  var self = this;
  log.debug("App.processEvent: %o", event);
  
  // 1. Get the monitor for this probe, to get its list of contacts.
  var userUuid = event.probe.user;
  var monitorName = event.probe.monitor;
  Monitor.get(this, userUuid, monitorName, function (err, monitor) {
    if (err) return callback(err);
    // 2. Notify each contact.
    function getAndNotifyContact(contactUrn, cb) {
      log.debug("App.processEvent: notify contact '%s' (userUuid='%s', "
        + "monitor='%s')", contactUrn, userUuid, monitorName);
      Contact.get(self, userUuid, contactUrn, function (err, contact) {
        if (err) {
          log.warn("could not resolve contact '%s' (user '%s'): %s",
            contactUrn, userUuid, err)
          return cb();
        }
        if (!contact.address) {
          log.info("no contact address (contactUrn='%s' monitor='%s' "
            + "userUuid='%s'), alerting monitor owner", contactUrn,
            monitorName, userUuid);
          var msg = "XXX"; // TODO
          self.alarmConfig(monitor.user, msg, function (err) {
            if (err) {
              log.error("could not alert monitor owner: %s", err);
            }
            return cb();
          });
        } else {
          self.notifyContact(userUuid, monitor, contact, event, function (err) {
            if (err) {
              log.warn("could not notify contact: %s", err);
            } else {
              log.debug("App.processEvent: contact '%s' notified (userUuid='%s', "
                + "monitor='%s')", contactUrn, userUuid, monitorName);
            }
            return cb();
          });
        }
      });
    }
    asyncForEach(monitor.contacts, getAndNotifyContact, function (err) {
      callback();
    });
  });
};


/**
 * Determine the appropriate notification type (email, sms, etc.) from
 * the given contact medium.
 *
 * Because we are using the simple mechanism of
 * an LDAP field name/value pair on a user (objectClass=sdcPerson in UFDS)
 * for a contact, we need conventions on the field *name* to map to a
 * particular plugin for handling the notification. E.g. both "email"
 * and "secondaryEmail" will map to the "email" notification type.
 *
 * @throws {restify.RESTError} if the no appropriate notification plugin could
 *    be determined.
 */
App.prototype.notificationTypeFromMedium = function(medium) {
  var self = this;
  var types = Object.keys(this.notificationPlugins);
  for (var i = 0; i < types.length; i++) {
    var type = types[i];
    var plugin = self.notificationPlugins[type];
    if (plugin.acceptsMedium(medium)) {
      return type;
    }
  }
  log.warn('Could not determine an appropriate notification plugin '
    + 'for "%s" medium.', medium);
  throw new restify.InvalidArgumentError(
    sprintf('Invalid or unsupported contact medium "%s".', medium));
}


/**
 * Alert the given user about an Amon configuration issue.
 *
 * Currently this will just send an email notification. Eventually this will
 * create a separate alarm instance and notify the given user via the
 * usual alarm handling mechanisms.
 *
 * @param userId {String} UUID or login of user to notify.
 * @param msg {String} Message to send. TODO: spec this out.
 * @param callback {Function} `function (err)`.
 *    TODO: return alarm or alarm id.
 */
App.prototype.alarmConfig = function (userId, msg, callback) {
  log.error("TODO: implement App.alarmConfig")
  callback();
}


/**
 * XXX clarify error handling
 * TODO:XXX Get this to take the full account object to allow improving the
 *    recipient, e.g. 'joe@example.com' -> '"Joe Smith" <joe@example.com>'
 *
 * ...
 * @param callback {Function} `function (err) {}`.
 */
App.prototype.notifyContact = function (userUuid, monitor, contact, event, callback) {
  var plugin = this.notificationPlugins[contact.notificationType];
  if (!plugin) {
    return callback("notification plugin '%s' not found", contact.notificationType);
  }
  plugin.notify(event.probe.name, contact.address,
    JSON.stringify(event.data,null,2), //XXX obviously lame "message" to send
    callback);
}


/**
 * Close this app.
 * 
 * @param {Function} callback called when closed. Takes no arguments.
 */
App.prototype.close = function(callback) {
  var self = this;
  this.server.on('close', function() {
    self.ufds.unbind(function() {
      return callback();
    });
  });
  this.server.close();
};



module.exports.createApp = createApp;
module.exports.App = App;
