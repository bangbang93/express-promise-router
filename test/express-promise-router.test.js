'use strict';

var assert = require('chai').assert;
var sinon = require('sinon');
var express = require('express');
var request = require('request-promise');

var delay = function(method, payload) {
    setTimeout(function() {
        method(payload);
    }, 10);
};

var PromiseRouter = require('../lib/express-promise-router.js');

describe('express-promise-router', function() {
    var app;
    var serverListening;
    var server;
    var router;

    var GET = function(route) {
        return request({ url: 'http://localhost:12345' + route, resolveWithFullResponse: true }).then(function(res) {
            // Express sends 500 errors for uncaught exceptions (like failed assertions)
            // Make sure to still fail the test if an assertion in middleware failed.
            assert.equal(res.statusCode, 200);
            return res;
        });
    };

    var bootstrap = function(router) {
        app = express();
        app.use('/', router);

        if (serverListening) {
            throw 'already bootstrapped';
        }

        serverListening = new Promise(function(resolve, reject) {
            server = app.listen(12345, function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });

        return serverListening;
    };

    beforeEach(function() {
        router = new PromiseRouter();
    });

    afterEach(function() {
        if (serverListening) {
            return serverListening.then(function() {
                server.close();
                app = undefined;
                server = undefined;
                serverListening = undefined;
            });
        }
    });

    it('should call next with an error when a returned promise is rejected', function() {
        var callback = sinon.spy();

        router.use('/foo', function() {
            return new Promise(function(resolve, reject) {
                delay(reject, 'some error');
            });
        });
        router.use(function(err, req, res, next) {
            assert.equal('some error', err);
            callback();
            res.send();
        });

        return bootstrap(router)
            .then(function() {
                return GET('/foo');
            })
            .then(function() {
                assert(callback.calledOnce);
            });
    });

    it('should call next without an error when a returned promise is resolved with "next"', function() {
        var errorCallback = sinon.spy();
        var nextCallback = sinon.spy();

        router.use('/foo', function() {
            return new Promise(function(resolve) {
                delay(resolve, 'next');
            });
        });
        router.use('/foo', function(req, res) {
            nextCallback();
            res.send();
        });
        router.use(function(err, req, res, next) {
            errorCallback();
            next();
        });

        return bootstrap(router)
            .then(function() {
                return GET('/foo');
            })
            .then(function() {
                assert(errorCallback.notCalled);
                assert(nextCallback.calledOnce);
            });
    });

    it('should not call next when a returned promise is resolved with anything other than "route" or "next"', function() {
        var callback = sinon.spy();

        router.get('/foo', function(req, res) {
            return new Promise(function(resolve) {
                res.send();
                delay(resolve, 'something');
            });
        });
        router.get('/bar', function(req, res) {
            return new Promise(function(resolve) {
                res.send();
                delay(resolve, {});
            });
        });
        router.use(function(req, res) {
            callback();
            res.send(500);
        });

        return bootstrap(router)
            .then(function() {
                return GET('/foo');
            })
            .then(function() {
                assert(callback.notCalled);
                return GET('/bar');
            })
            .then(function() {
                assert(callback.notCalled);
            });
    });

    it('should move to the next middleware when next is called without an error', function() {
        var callback = sinon.spy();

        router.use('/foo', function(req, res, next) {
            next();
        });
        router.use('/foo', function(req, res, next) {
            callback();
            res.send();
        });

        return bootstrap(router)
            .then(function() {
                return GET('/foo');
            })
            .then(function() {
                assert(callback.calledOnce);
            });
    });

    it('should move to the next error handler when next is called with an error', function() {
        var callback = sinon.spy();
        var errorCallback = sinon.spy();

        router.use('/foo', function(req, res, next) {
            next('an error');
        });
        router.use('/foo', function(req, res, next) {
            callback();
            next();
        });
        router.use(function(err, req, res, next) {
            assert.equal('an error', err);
            errorCallback();
            res.send();
        });

        return bootstrap(router)
            .then(function() {
                return GET('/foo');
            })
            .then(function() {
                assert(errorCallback.calledOnce);
                assert(callback.notCalled);
            });
    });

    it('should call chained handlers in the correct order', function() {
        var fn2 = sinon.spy(function(req, res) {
            res.send();
        });
        var fn1 = sinon.spy(function() {
            assert(fn2.notCalled);
            return Promise.resolve('next');
        });

        router.get('/foo', fn1, fn2);

        return bootstrap(router).then(function() {
            return GET('/foo');
        });
    });

    it('should correctly call an array of handlers', function() {
        var fn2 = sinon.spy(function(req, res) {
            res.send();
        });
        var fn1 = sinon.spy(function() {
            assert(fn2.notCalled);
            return Promise.resolve('next');
        });

        router.get('/foo', [[fn1], [fn2]]);

        return bootstrap(router).then(function() {
            return GET('/foo');
        });
    });

    it('should call next("route") if a returned promise is resolved with "route"', function() {
        var fn1 = function() {
            return Promise.resolve('route');
        };
        var fn2 = function() {
            assert.fail();
        };

        router.get('/foo', fn1, fn2);
        router.get('/foo', function(req, res) {
            res.send();
        });

        return bootstrap(router).then(function() {
            return GET('/foo');
        });
    });

    it('should bind to RegExp routes', function() {
        var fn1 = function(req, res) {
            res.send();
        };

        router.get(/^\/foo/, fn1);

        return bootstrap(router).then(function() {
            return GET('/foo');
        });
    });

    it('multiple calls to handlers that have used "next" should not interfere with each other', function() {
        var fn = sinon.spy(function(req, res, next) {
            if (fn.calledOnce) {
                next('error');
            } else {
                setTimeout(function() {
                    res.status(200).send('ok');
                }, 15);
            }
        });
        var errHandler = function(err, req, res, next) {
            if (err === 'error') {
                res.send('fail');
            } else {
                next(err);
            }
        };

        router.get('/foo', fn, errHandler);

        return bootstrap(router)
            .then(function() {
                return GET('/foo');
            })
            .then(function(res) {
                assert.equal(res.body, 'fail');
                return GET('/foo');
            })
            .then(function(res) {
                assert.equal(res.body, 'ok');
            });
    });

    it('calls next if next is called even if the handler returns a promise', function() {
        var fn = function(req, res, next) {
            next();
            return new Promise(function(resolve, reject) {});
        };
        var fn2 = function(req, res) {
            res.send('ok');
        };
        var errHandler = function(err, req, res, next) {
            res.send('error');
        };

        router.get('/foo', fn, fn2, errHandler);

        return bootstrap(router)
            .then(function() {
                return GET('/foo');
            })
            .then(function(res) {
                assert.equal(res.body, 'ok');
            });
    });

    it('calls next with an error if the returned promise is rejected with no reason', function() {
        var fn = function() {
            return new Promise(function(resolve, reject) {
                delay(reject, null);
            });
        };
        var errHandler = function(err, req, res, next) {
            res.send('error');
        };

        router.get('/foo', fn, errHandler);

        return bootstrap(router)
            .then(function() {
                return GET('/foo');
            })
            .then(function(res) {
                assert.equal(res.body, 'error');
            });
    });

    it('should handle resolved promises returned in req.param() calls', function() {
        router.param('id', function() {
            return new Promise(function(resolve) {
                delay(resolve, 'next');
            });
        });
        router.use('/foo/:id', function(req, res) {
            res.send('done');
        });

        return bootstrap(router)
            .then(function() {
                return GET('/foo/1');
            })
            .then(function(res) {
                assert.equal(res.body, 'done');
            });
    });

    it('should call next with unresolved promises returned in req.param() calls', function() {
        var assertOutput = 'error in param';

        router.param('id', function(req, res, next, id) {
            return new Promise(function(resolve, reject) {
                delay(reject, assertOutput);
            });
        });

        var fn = function(req, res) {
            res.send('done');
        };

        var errHandler = function(err, req, res, next) {
            res.send(err);
        };

        router.use('/foo/:id', fn);

        router.use(errHandler);

        return bootstrap(router)
            .then(function() {
                return GET('/foo/1');
            })
            .then(function(res) {
                assert.equal(res.body, assertOutput);
            });
    });

    it('support array in routes values', function() {
        router.use(['/', '/foo/:bar'], function(req, res) {
            res.send('done');
        });

        return bootstrap(router)
            .then(function() {
                return GET('/');
            })
            .then(function(res) {
                assert.equal(res.body, 'done');

                return GET('/foo/1');
            })
            .then(function(res) {
                assert.equal(res.body, 'done');
            });
    });

    it('should throw sensible errors when handler is not a function', function() {
        assert.throws(function() {
            router.use('/foo/:id', null);
        }, /callback/);
    });
});
