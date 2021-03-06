// Load modules

var Url = require('url');
var Async = require('async');
var Boom = require('boom');
var Hoek = require('hoek');

// Declare internals

var internals = {};


module.exports.config = function (settings) {

    var config = {};
    delete settings.batchEndpoint;
    for (var attrname in settings) {
        config[attrname] = settings[attrname];
    }

    config.handler = function (request, reply) {

        var resultsData = {
            results: [],
            resultsMap: [],
            success: 0,
            errors: []
        };

        var requests = [];
        var requestRegex = /(?:\/)(?:\$(\d)+\.)?([^\/\$]*)/g;    // /project/$1.project/tasks, does not allow using array responses

        // Validate requests

        var errorMessage = null;
        var parseRequest = function ($0, $1, $2) {

            if ($1) {
                if ($1 < i) {
                    parts.push({ type: 'ref', index: $1, value: $2 });
                    return '';
                }

                errorMessage = 'Request reference is beyond array size: ' + i;
                return $0;
            }

            parts.push({ type: 'text', value: $2 });
            return '';
        };

        if (!request.payload.requests) {
            return reply(Boom.badRequest('Request missing requests array'));
        }

        if (request.payload.requestId) {
            resultsData.id = request.payload.requestId;
        }

        for (var i = 0, il = request.payload.requests.length; i < il; ++i) {

            // Break into parts

            var parts = [];
            var result = request.payload.requests[i].path.replace(requestRegex, parseRequest);

            // Make sure entire string was processed (empty)

            if (result === '') {
                requests.push(parts);
            }
            else {
                errorMessage = errorMessage || 'Invalid request format in item: ' + i;
                break;
            }
        }

        if (errorMessage === null) {
            internals.process(request, requests, resultsData, reply);
        }
        else {
            reply(Boom.badRequest(errorMessage));
        }
    };

    return config;
};


    internals.process = function (request, requests, resultsData, reply) {

        var fnsParallel = [];
        var fnsSerial = [];
        var callBatch = function (pos, batchParts) {

            return function (callback) {

                internals.batch(request, resultsData, pos, batchParts, callback);
            };
        };

        for (var i = 0, il = requests.length; i < il; ++i) {
            var parts = requests[i];

            if (internals.hasRefPart(parts)) {
                fnsSerial.push(callBatch(i, parts));
            }
            else {
                fnsParallel.push(callBatch(i, parts));
        }
    }

    Async.series([
        function (callback) {

            Async.parallel(fnsParallel, callback);
        },
        function (callback) {

            Async.series(fnsSerial, callback);
        }
    ], function (err) {

        if (err) {
            reply(err);
        }
        else {
            //Build response object
            var response = {
                success: resultsData.success,
                failureCodes: resultsData.errors
            }
            //Only pass back array of responses if indicated in request
            if (request.payload.includeResponses) {
                response.responses = resultsData.results;
            }
            if (resultsData.id) {
                response.requestId = resultsData.id;
            }
            reply(response);
        }
    });
};


internals.hasRefPart = function (parts) {

    for (var i = 0, il = parts.length; i < il; ++i) {
        if (parts[i].type === 'ref') {
            return true;
        }
    }

    return false;
};


internals.batch = function (batchRequest, resultsData, pos, parts, callback) {

    //TODO accept this in plugin configuration
    function getErrorCode (result) {
        if (result.statusCode && result.statusCode >= 400) {
            return result.statusCode;
        }
    }

    var path = '';
    var error = null;

    function addErrorCode (code) {
        for (var i = 0; i < resultsData.errors.length; i++) {
            if (resultsData.errors[i].code === code) {
                resultsData.errors[i].count++;
                return;
            }
        }
        resultsData.errors.push({
            code: code,
            count: 1
        });
    }

    for (var i = 0, il = parts.length; i < il; ++i) {
        path += '/';

        if (parts[i].type === 'ref') {
            var ref = resultsData.resultsMap[parts[i].index];

            if (ref) {
                var value = Hoek.reach(ref, parts[i].value);

                if (value !== null && value !== undefined) {

                    if (/^[\w:]+$/.test(value)) {
                        path += value;
                    }
                    else {
                        error = new Error('Reference value includes illegal characters');
                        break;
                    }
                }
                else {
                    error = new Error('Reference not found');
                    break;
                }
            }
            else {
                error = new Error('Missing reference response');
                break;
            }
        }
        else {
            path += parts[i].value;
        }
    }

    if (error === null) {

        // Make request
        batchRequest.payload.requests[pos].path = path;
        internals.dispatch(batchRequest, batchRequest.payload.requests[pos], function (data) {

            // If redirection
            if (('' + data.statusCode).indexOf('3') === 0) {
                batchRequest.payload.requests[pos].path = data.headers.location;
                internals.dispatch(batchRequest, batchRequest.payload.requests[pos], function (batchData) {

                    var batchResult = batchData.result;

                    resultsData.results[pos] = batchResult;
                    resultsData.resultsMap[pos] = batchResult;
                    callback(null, batchResult);
                });
                return;
            }

            var result = data.result;
            resultsData.results[pos] = result;
            resultsData.resultsMap[pos] = result;
            //If there is an error, add it to our error array
            var errorCode = getErrorCode(result);
            if (errorCode) {
                addErrorCode(errorCode);
            } else {
                resultsData.success++;
            }
            callback(null, result);
        });
    }
    else {
        resultsData.results[pos] = error;
        return callback(error);
    }
};


internals.dispatch = function (batchRequest, request, callback) {

    var path = request.path;

    if (request.query) {
        var urlObject = {
            pathname: request.path,
            query: request.query
        };
        path = Url.format(urlObject);
    }

    var body = (request.payload !== null && request.payload !== undefined ? JSON.stringify(request.payload) : null);     // payload can be '' or 0
    var injectOptions = {
        url: path,
        method: request.method,
        headers: batchRequest.headers,
        payload: body
    };
    if (batchRequest.server.connections.length === 1) {
        batchRequest.server.inject(injectOptions, callback);
    }
    else {
        batchRequest.connection.inject(injectOptions, callback);
    }
};
