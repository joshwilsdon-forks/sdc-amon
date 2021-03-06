/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Amon Master controller for '/events' endpoints.
 */

var restify = require('restify');

var errors = require('./errors');



//---- internal support routines

/* BEGIN JSSTYLED */
/* jsl:ignore */
/**
 * Run async `fn` on each entry in `list`. Call `cb(error)` when all done.
 * `fn` is expected to have `fn(item, callback) -> callback(error)` signature.
 *
 * From Isaac's rimraf.js.
 */
function asyncForEach(list, fn, cb) {
    if (!list.length) cb();
    var c = list.length
        , errState = null;
    list.forEach(function (item, i, lst) {
        fn(item, function (er) {
            if (errState)
                return true;
            if (er)
                return cb(errState = er);
            if (-- c === 0)
                return cb();
        });
    });
}
/* jsl:end */
/* END JSSTYLED */


//---- controllers

/**
 * Process the given events. This accepts either a single event (an object)
 * or an array of events. Each event is treated independently such that
 * one event may have validation errors, but other events in the array will
 * still get processed.
 *
 * TODO: Improve the error story here. Everything is a 500, even for invalid
 *    event fields. That is lame.
 */
function addEvents(req, res, next) {
    var events;
    if (Array.isArray(req.body)) {
        events = req.body;
    } else {
        events = [req.body];
    }
    req.log.debug({events: events}, 'addEvents');

    // Collect errors so first failure doesn't abort the others.
    var errs = [];
    function validateAndProcess(event, cb) {
        //XXX event validation would go here

        req._app.processEvent(event, function (err) {
            if (err) {
                errs.push(err);
            }
            cb();
        });
    }

    asyncForEach(events, validateAndProcess, function (err) {
        if (errs.length > 0) {
            for (var i = 0; i < errs.length; i++) {
                req.log.warn({err: errs[i], i: i}, 'error adding event');
            }
            if (errs.length === 1) {
                next(errs[0]);
            } else {
                next(new errors.MultiError(errs));
            }
        } else {
            res.send(202 /* Accepted */);
            next();
        }
    });
}


//---- exports

/**
 * Mount API endpoints
 *
 * @param server {restify.Server}
 */
function mountApi(server) {
    server.post({path: '/events', name: 'AddEvents'}, addEvents);
}


module.exports = {
    mountApi: mountApi
};
