// Copyright 2011 Joyent, Inc.  All rights reserved.

var http = require('httpu');
var uuid = require('node-uuid');
var restify = require('restify');

var Config = require('amon-common').Config;
var App = require('../../lib/app');
var common = require('amon-common')._test;

// Our stuff for running
restify.log.level(restify.LogLevel.Trace);

// Generated Stuff
var id;
var check;
var customer;
var zone;

function _options(path) {
  var options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Version': '6.1.0'
    },
    path: '/events',
    socketPath: socketPath
  };
  if (path) options.path += path;
  return options;
}

exports.setUp = function(test, assert) {
  customer = uuid();
  zone = uuid();
  socketPath = '/tmp/.' + uuid();

  var cfg = new Config({});
  cfg.plugins = require('amon-plugins');
  cfg.redis = {
    host: 'localhost',
    port: process.env.REDIS_PORT || 6379
  };

  app = new App({
    port: socketPath,
    config: cfg
  });
  app.listen(function() {
    var opts = _options();
    opts.path = '/checks';
    var req = http.request(opts, function(res) {
      common.checkResponse(assert, res);
      assert.equal(res.statusCode, 201);
      common.checkContent(assert, res, function() {
        check = res.params.id;
        test.finish();
      });
    });

    req.write(JSON.stringify({
      customer: customer,
      zone: zone,
      urn: 'amon:logscan',
      config: {
        path: '/' + uuid(),
        regex: '*',
        period: 10,
        threshold: 1
      }
    }));
    req.end();
  });
};

exports.test_missing_status = function(test, assert) {
  http.request(_options(), function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 409);
    common.checkContent(assert, res, function() {
      assert.ok(res.params);
      assert.ok(res.params.code);
      assert.ok(res.params.message);
      assert.equal(res.params.code, 'MissingParameter');
      test.finish();
    });
  }).end();
};

exports.test_missing_metrics = function(test, assert) {
  http.request(_options('?status=ok'), function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 409);
    common.checkContent(assert, res, function() {
      assert.ok(res.params);
      assert.ok(res.params.code);
      assert.ok(res.params.message);
      assert.equal(res.params.code, 'MissingParameter');
      test.finish();
    });
  }).end();
};

exports.test_invalid_status = function(test, assert) {
  var opts = _options('?status=' + uuid() + '&metrics=foo');
  http.request(opts, function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 409);
    common.checkContent(assert, res, function() {
      assert.ok(res.params);
      assert.ok(res.params.code);
      assert.ok(res.params.message);
      assert.equal(res.params.code, 'InvalidArgument');
      test.finish();
    });
  }).end();
};


exports.test_bogus_check = function(test, assert) {
  var req = http.request(_options(), function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 404);
    common.checkContent(assert, res, function() {
      assert.ok(res.params);
      assert.ok(res.params.code);
      assert.ok(res.params.message);
      assert.equal(res.params.code, 'InvalidArgument');
      test.finish();
    });
  });

  req.write(JSON.stringify({
    status: 'ok',
    check: uuid(),
    zone: zone,
    customer: customer,
    metrics: {
      name: 'urn:cpu:util',
      type: 'Integer',
      value: 95
    }
  }));
  req.end();
};

exports.test_bogus_customer = function(test, assert) {
  var req = http.request(_options(), function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 409);
    common.checkContent(assert, res, function() {
      assert.ok(res.params);
      assert.ok(res.params.code);
      assert.ok(res.params.message);
      assert.equal(res.params.code, 'InvalidArgument');
      test.finish();
    });
  });

  req.write(JSON.stringify({
    status: 'ok',
    check: check,
    zone: zone,
    customer: uuid(),
    metrics: {
      name: 'urn:cpu:util',
      type: 'Integer',
      value: 95
    }
  }));
  req.end();
};

exports.test_bogus_zone = function(test, assert) {
  var req = http.request(_options(), function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 409);
    common.checkContent(assert, res, function() {
      assert.ok(res.params);
      assert.ok(res.params.code);
      assert.ok(res.params.message);
      assert.equal(res.params.code, 'InvalidArgument');
      test.finish();
    });
  });

  req.write(JSON.stringify({
    status: 'ok',
    check: check,
    zone: uuid(),
    customer: customer,
    metrics: {
      name: 'urn:cpu:util',
      type: 'Integer',
      value: 95
    }
  }));
  req.end();
};

exports.test_success_with_object = function(test, assert) {
  var req = http.request(_options(), function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 201);
    test.finish();
  });

  req.write(JSON.stringify({
    status: 'ok',
    check: check,
    zone: zone,
    customer: customer,
    metrics: {
      name: 'urn:cpu:util',
      type: 'Integer',
      value: 95
    }
  }));
  req.end();
};

exports.test_success_with_array = function(test, assert) {
  var req = http.request(_options(), function(res) {
    common.checkResponse(assert, res);
    assert.equal(res.statusCode, 201);
    test.finish();
  });

  req.write(JSON.stringify({
    status: 'ok',
    check: check,
    zone: zone,
    customer: customer,
    metrics: [{
      name: 'urn:cpu:util',
      type: 'Integer',
      value: 95
    }]
  }));
  req.end();
};

exports.tearDown = function(test, assert) {
  app.redis.flushdb(function(err, res) {
    app.close(function() {
      test.finish();
    });
  });
};
