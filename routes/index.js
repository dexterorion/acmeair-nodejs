/*******************************************************************************
* Copyright (c) 2015 IBM Corp.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*    http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*******************************************************************************/


import log4js from 'log4js';
import ttlLruCache from 'ttl-lru-cache';
import { settings, dbtype } from '../globals.js';
import { generateUUID } from '../support.js';
import getDataAccess from '../dataaccess/dataaccess.js';

const flightCache = ttlLruCache({ maxLength: settings.flightDataCacheMaxSize });
const flightSegmentCache = ttlLruCache({ maxLength: settings.flightDataCacheMaxSize });
var flightDataCacheTTL = settings.flightDataCacheTTL == -1 ? null : settings.flightDataCacheTTL;

var logger = log4js.getLogger('routes');
logger.level = settings.loggerLevel;

async function checkForValidSessionCookieRest(params) {
    logger.debug('checkForValidCookie');
    var sessionid = params.sessionid;
    if (sessionid) {
        sessionid = sessionid.trim();
    }
    if (!sessionid || sessionid == '') {
        logger.debug('checkForValidCookie - no sessionid cookie so returning 403');
        return { status: 403 };
    }

    logger.debug("Validating session cookie. Sessionid="+sessionid);

    try {
        const customerid = await validateSession(sessionid);
        if (customerid) {
            logger.debug('checkForValidCookie - good session so allowing next route handler to be called');
            return { acmeair_login_user: customerid };
        }
        else {
            logger.debug('checkForValidCookie - bad session so returning 403');
            return { status: 403 };
        }
    } catch (err) {
        logger.debug('checkForValidCookie - system error validating session so returning 500');
        return { status: 500 };
    }
}

async function checkForValidSessionCookie(req, res, next) {
    var result = await checkForValidSessionCookieRest({ sessionid: req.cookies.sessionid });
    if (result.status) {
        res.sendStatus(result.status);
        return;
    }
    req.acmeair_login_user = result.acmeair_login_user;
    next();
}

async function loginRest(params) {
    logger.debug('logging in user');
    var login = params.login;
    var password = params.password;

    // replace eventually with call to business logic to validate customer
    const customerValid = await validateCustomer(login, password);
    try {
        if (!customerValid) {
            return { status: 403 };
        }
        else {
            try {
                const sessionid = await createSession(login);
                logger.debug("Logged in. Session id="+sessionid);
                return { sessionid: sessionid };
            } catch (error) {
                logger.info(error);
                return { status: 500, error: error };
            }
        }
    } catch (err) {
        return { status: 500, error: err };
    }
}

async function login(req, res) {
    res.cookie('sessionid', '');

    var result = await loginRest({ login: req.body.login, password: req.body.password });
    if (result.status) {
        res.sendStatus(result.status);
        return;
    }
    res.cookie('sessionid', result.sessionid);
    res.send('logged in');
}

async function logoutRest(params) {
    logger.debug('logging out user');
    var sessionid = params.sessionid;
    await invalidateSession(sessionid);
    return { sessionid: '' };
}

async function logout(req, res) {
    var result = await logoutRest({ sessionid: req.cookies.sessionid });
    res.cookie('sessionid', result.sessionid);
    res.send('logged out');
};

async function queryflightsRest(params) {
    logger.debug('querying flights');

    var fromAirport = params.fromAirport;
    var toAirport = params.toAirport;
    var fromDateWeb = new Date(params.fromDate);
    var fromDate = new Date(fromDateWeb.getFullYear(), fromDateWeb.getMonth(), fromDateWeb.getDate()); // convert date to local timezone
    var oneWay = (params.oneWay == 'true');
    var returnDateWeb = new Date(params.returnDate);
    var returnDate;
    if (!oneWay) {
        returnDate = new Date(returnDateWeb.getFullYear(), returnDateWeb.getMonth(), returnDateWeb.getDate()); // convert date to local timezone
    }

    let [flightSegmentOutbound, flightsOutbound] = await getFlightByAirportsAndDepartureDate(fromAirport, toAirport, fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
    logger.debug('flightsOutbound = ' + JSON.stringify(flightsOutbound));
    if (flightsOutbound) {
        for (let ii = 0; ii < flightsOutbound.length; ii++) {
            flightsOutbound[ii].flightSegment = flightSegmentOutbound;
        }
    }
    else {
        flightsOutbound = [];
    }
    if (!oneWay) {
        let [flightSegmentReturn, flightsReturn] = await getFlightByAirportsAndDepartureDate(toAirport, fromAirport, returnDate.getFullYear(), returnDate.getMonth(), returnDate.getDate());
        logger.debug('flightsReturn = ' + JSON.stringify(flightsReturn));
        if (flightsReturn) {
            for (let ii = 0; ii < flightsReturn.length; ii++) {
                flightsReturn[ii].flightSegment = flightSegmentReturn;
            }
        }
        else {
            flightsReturn = [];
        }
        var options = {
            "tripFlights":
                [
                    { "numPages": 1, "flightsOptions": flightsOutbound, "currentPage": 0, "hasMoreOptions": false, "pageSize": 10 },
                    { "numPages": 1, "flightsOptions": flightsReturn, "currentPage": 0, "hasMoreOptions": false, "pageSize": 10 }
                ], "tripLegs": 2
        };
        return { options: options };
    }
    else {
        var options = {
            "tripFlights":
                [
                    { "numPages": 1, "flightsOptions": flightsOutbound, "currentPage": 0, "hasMoreOptions": false, "pageSize": 10 }
                ], "tripLegs": 1
        };
        return { options: options };
    }
}

async function queryflights(req, res) {
    var result = await queryflightsRest({
        fromAirport: req.body.fromAirport,
        toAirport: req.body.toAirport,
        fromDate: req.body.fromDate,
        oneWay: req.body.oneWay,
        returnDate: req.body.returnDate
    });
    res.send(result.options);
};

async function bookflightsRest(params) {
    logger.debug('booking flights');

    var userid = params.userid;
    var toFlight = params.toFlightId;
    var retFlight = params.retFlightId;
    var oneWay = (params.oneWayFlight == 'true');

    logger.debug("toFlight:" + toFlight + ",retFlight:" + retFlight);

    const toBookingId = await bookFlight(toFlight, userid);

    if (!oneWay) {
        const retBookingId = await bookFlight(retFlight, userid);
        var bookingInfo = { "oneWay": false, "returnBookingId": retBookingId, "departBookingId": toBookingId };
        return bookingInfo;
    } else {
        var bookingInfo = { "oneWay": true, "departBookingId": toBookingId };
        return bookingInfo;
    }
};

async function bookflights(req, res) {
    var result = await bookflightsRest({
        userid: req.body.userid,
        toFlightId: req.body.toFlightId,
        retFlightId: req.body.retFlightId,
        oneWayFlight: req.body.oneWayFlight
    });
    res.header('Cache-Control', 'no-cache');
    res.send(result);
};

async function cancelBookingRest(params) {
    logger.debug('canceling booking');

    var number = params.number;
    var userid = params.userid;

    try {
        await cancelBookingInDB(number, userid);
        return { 'status': 'success' };
    } catch (error) {
        return { 'status': 'error' };
    }
};

async function cancelBooking(req, res) {
    var result = await cancelBookingRest({
        number: req.body.number,
        userid: req.body.userid
    });
    res.send(result);
};

async function bookingsByUserRest(params) {
    logger.debug('listing booked flights by user ' + params.user);

    try {
        const bookings = await getBookingsByUser(params.user);
        return { bookings: bookings };
    } catch (err) {
        return { status: 500 };
    }
};

async function bookingsByUser(req, res) {
    var result = await bookingsByUserRest({ user: req.params.user });
    if (result.status) {
        res.sendStatus(result.status);
        return;
    }
    res.send(result.bookings);
}

async function getCustomerByIdRest(params) {
    logger.debug('getting customer by user ' + params.user);

    try {
        const customer = await getCustomer(params.user);
        return { customer: customer };
    } catch (err) {
        return { status: 500 };
    }
};

async function getCustomerById(req, res) {
    var result = await getCustomerByIdRest({ user: req.params.user });
    if (result.status) {
        res.sendStatus(result.status);
        return;
    }
    res.send(result.customer);
};

async function putCustomerByIdRest(params) {
    logger.debug('putting customer by user ' + params.user);

    try {
        const customer = await updateCustomer(params.user, params.body);
        return { customer: customer };
    } catch (err) {
        return { status: 500 };
    }
};

async function putCustomerById(req, res) {
    var result = await putCustomerByIdRest({ user: req.params.user, body: req.body });
    if (result.status) {
        res.sendStatus(result.status);
        return;
    }
    res.send(result.customer);
};

async function getRuntimeInfoRest(params) {
    var runtimeInfo = [];
    runtimeInfo.push({ "name": "Runtime", "description": "NodeJS" });
    var versions = process.versions;
    for (var key in versions) {
        runtimeInfo.push({ "name": key, "description": versions[key] });
    }
    return runtimeInfo;
};

async function getRuntimeInfo(req, res) {
    var runtimeInfo = await getRuntimeInfoRest({});
    res.contentType('application/json');
    res.send(JSON.stringify(runtimeInfo));
};

async function getDataServiceInfoRest(params) {
    var dataServices = [{ "name": "cassandra", "description": "Apache Cassandra NoSQL DB" },
    { "name": "cloudant", "description": "IBM Distributed DBaaS" },
    { "name": "mongo", "description": "MongoDB NoSQL DB" }];
    return dataServices;
};

async function getDataServiceInfo(req, res) {
    var dataServices = await getDataServiceInfoRest({});
    res.send(JSON.stringify(dataServices));
};

function getActiveDataServiceInfoRest(params) {
    return dbtype;
};

async function getActiveDataServiceInfo(req, res) {
    var dbtype = getActiveDataServiceInfoRest({});
    res.send(dbtype);
};

async function countBookingsRest(params) {
    try {
        const count = await countBookingsDB();
        return count.toString();
    } catch (error) {
        return "-1";
    }
};

async function countBookings(req, res) {
    var count = await countBookingsRest({});
    res.send(count);
};

async function countCustomerRest(params) {
    try {
        const count = await countCustomersDB();
        return count.toString();
    } catch (error) {
        return "-1";
    }
};

async function countCustomer(req, res) {
    var count = await countCustomerRest({});
    res.send(count);
};

async function countCustomerSessionsRest(params) {
    try {
        const count = await countCustomerSessionsDB();
        return count.toString();
    } catch (error) {
        return "-1";
    }
};

async function countCustomerSessions(req, res) {
    var count = await countCustomerSessionsRest({});
    res.send(count);
};

async function countFlightsRest(params) {
    try {
        const count = await countFlightsDB();
        return count.toString();
    } catch (error) {
        return "-1";
    }
};

async function countFlights(req, res) {
    var count = await countFlightsRest({});
    res.send(count);
};

async function countFlightSegmentsRest(params) {
    try {
        const count = await countFlightSegmentsDB();
        return count.toString();
    } catch (error) {
        return "-1";
    }
};

async function countFlightSegments(req, res) {
    var count = await countFlightSegmentsRest({});
    res.send(count);
};

async function countAirportsRest(params) {
    try {
        const count = await countAirportsDB();
        return count.toString();
    } catch (error) {
        console.log(error);
        return "-1";
    }
};

async function countAirports(req, res) {
    var count = await countAirportsRest({});
    res.send(count);
};

async function countBookingsDB() {
    const dataaccess = await getDataAccess();
    const count = await dataaccess.count(dataaccess.dbNames.bookingName, {});
    return count;
};

async function countCustomersDB() {
    const dataaccess = await getDataAccess();
    const count = await dataaccess.count(dataaccess.dbNames.customerName, {});
    return count;
};

async function countCustomerSessionsDB() {
    const dataaccess = await getDataAccess();
    const count = await dataaccess.count(dataaccess.dbNames.customerSessionName, {});
    return count;
};

async function countFlightsDB() {
    const dataaccess = await getDataAccess();
    const count = await dataaccess.count(dataaccess.dbNames.flightName, {});
    return count;
};

async function countFlightSegmentsDB() {
    const dataaccess = await getDataAccess();
    const count = await dataaccess.count(dataaccess.dbNames.flightSegmentName, {});
    return count;
};

async function countAirportsDB() {
    const dataaccess = await getDataAccess();
    const count = await dataaccess.count(dataaccess.dbNames.airportCodeMappingName, {});
    return count;
};

async function validateCustomer(username, password) {
    const dataaccess = await getDataAccess();
    const customer = await dataaccess.findOne(dataaccess.dbNames.customerName, username);
    if (customer) {
        return customer.password == password;
    }
    return false;
};

async function createSession(customerId) {
    var now = new Date();
    var later = new Date(now.getTime() + 1000 * 60 * 60 * 24);

    var document = { "_id": generateUUID(), "customerid": customerId, "lastAccessedTime": now, "timeoutTime": later };

    const dataaccess = await getDataAccess();
    await dataaccess.insertOne(dataaccess.dbNames.customerSessionName, document);
    return document._id;
}

async function validateSession(sessionId) {
    var now = new Date();

    const dataaccess = await getDataAccess();
    const session = await dataaccess.findOne(dataaccess.dbNames.customerSessionName, sessionId);
    if (now > session.timeoutTime) {
        await dataaccess.remove(dataaccess.dbNames.customerSessionName, { '_id': sessionId });
        return null;
    }
    else {
        return session.customerid;
    }
}

async function getCustomer(username) {
    const dataaccess = await getDataAccess();
    return await dataaccess.findOne(dataaccess.dbNames.customerName, username);
}

async function updateCustomer(login, customer) {
    const dataaccess = await getDataAccess();
    return await dataaccess.update(dataaccess.dbNames.customerName, customer);
}

async function getBookingsByUser(username) {
    const dataaccess = await getDataAccess();
    return await dataaccess.findBy(dataaccess.dbNames.bookingName, { 'customerId': username });
}

async function invalidateSession(sessionid) {
    const dataaccess = await getDataAccess();
    await dataaccess.remove(dataaccess.dbNames.customerSessionName, { '_id': sessionid });
}

async function getFlightByAirportsAndDepartureDate(fromAirport, toAirport, flightDateYear, flightDateMonth, flightDateDate) {
    logger.debug("getFlightByAirportsAndDepartureDate " + fromAirport + " " + toAirport + " " + flightDateMonth+"/"+flightDateDate+"/"+flightDateYear);

    const flightsegment = await getFlightSegmentByOriginPortAndDestPort(fromAirport, toAirport);
    logger.debug("flightsegment = " + JSON.stringify(flightsegment));
    if (!flightsegment) {
        return [null, null];
    }

    var date = new Date(flightDateYear, flightDateMonth, flightDateDate, 0, 0, 0, 0);

    var cacheKey = flightsegment._id + "-" + date.getTime();
    if (settings.useFlightDataRelatedCaching) {
        var flights = flightCache.get(cacheKey);
        if (flights) {
            logger.debug("cache hit - flight search, key = " + cacheKey);
            return [flightsegment, (flights == "NULL" ? null : flights)];
        }
        logger.debug("cache miss - flight search, key = " + cacheKey + " flightCache size = " + flightCache.size());
    }
    var searchCriteria = { flightSegmentId: flightsegment._id, scheduledDepartureTime: date };
    const dataaccess = await getDataAccess();
    const docs = await dataaccess.findBy(dataaccess.dbNames.flightName, searchCriteria);
    ("after cache miss - key = " + cacheKey + ", docs = " + JSON.stringify(docs));

    var docsEmpty = !docs || docs.length == 0;

    if (settings.useFlightDataRelatedCaching) {
        var cacheValue = (docsEmpty ? "NULL" : docs);
        ("about to populate the cache with flights key = " + cacheKey + " with value of " + JSON.stringify(cacheValue));
        flightCache.set(cacheKey, cacheValue, flightDataCacheTTL);
        ("after cache populate with key = " + cacheKey + ", flightCacheSize = " + flightCache.size())
    }
    return [flightsegment, docs];
}

async function getFlightSegmentByOriginPortAndDestPort(fromAirport, toAirport) {
    var segment;

    if (settings.useFlightDataRelatedCaching) {
        segment = flightSegmentCache.get(fromAirport + toAirport);
        if (segment) {
            ("cache hit - flightsegment search, key = " + fromAirport + toAirport);
            return (segment == "NULL" ? null : segment);
        }
        ("cache miss - flightsegment search, key = " + fromAirport + toAirport + ", flightSegmentCache size = " + flightSegmentCache.size());
    }
    const dataaccess = await getDataAccess();
    const docs = await dataaccess.findBy(
        dataaccess.dbNames.flightSegmentName,
        { originPort: fromAirport, destPort: toAirport });
    segment = docs[0];
    if (segment == undefined) {
        segment = null;
    }
    if (settings.useFlightDataRelatedCaching) {
        ("about to populate the cache with flightsegment key = " + fromAirport + toAirport + " with value of " + JSON.stringify(segment));
        flightSegmentCache.set(fromAirport + toAirport, (segment == null ? "NULL" : segment), flightDataCacheTTL);
        ("after cache populate with key = " + fromAirport + toAirport + ", flightSegmentCacheSize = " + flightSegmentCache.size())
    }
    return segment;
}

async function bookFlight(flightId, userid) {

    var now = new Date();
    var docId = generateUUID();

    var document = { "_id": docId, "customerId": userid, "flightId": flightId, "dateOfBooking": now };

    const dataaccess = await getDataAccess();
    await dataaccess.insertOne(dataaccess.dbNames.bookingName, document);
    return docId;
}

async function cancelBookingInDB(bookingid, userid) {
    const dataaccess = await getDataAccess();
    await dataaccess.remove(dataaccess.dbNames.bookingName, { '_id': bookingid, 'customerId': userid })
}

export default {
    checkForValidSessionCookie,
    login,
    logout,
    queryflights,
    bookflights,
    cancelBooking,
    bookingsByUser,
    getCustomerById,
    putCustomerById,
    getRuntimeInfo,
    getDataServiceInfo,
    getActiveDataServiceInfo,
    countBookings,
    countCustomer,
    countCustomerSessions,
    countFlights,
    countFlightSegments,
    countAirports
}