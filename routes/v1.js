var express = require('express');
var Router = require('express').Router;
var reverseQuery = require('../query/reverse');

/** ----------------------- sanitisers ----------------------- **/
var sanitisers = {
  autocomplete: require('../sanitiser/autocomplete'),
  place: require('../sanitiser/place'),
  search: require('../sanitiser/search'),
  reverse: require('../sanitiser/reverse')
};

/** ----------------------- middleware ------------------------ **/
var middleware = {
  calcSize: require('../middleware/sizeCalculator'),
  selectLanguage: require('../middleware/languageSelector')
};

/** ----------------------- controllers ----------------------- **/

var controllers = {
  mdToHTML: require('../controller/markdownToHtml'),
  place: require('../controller/place'),
  search: require('../controller/search'),
  status: require('../controller/status')
};

/** ----------------------- controllers ----------------------- **/

var postProc = {
  matchLanguage: require('../middleware/matchLanguage'),
  distances: require('../middleware/distance'),
  confidenceScores: require('../middleware/confidenceScore'),
  confidenceScoresReverse: require('../middleware/confidenceScoreReverse'),
  dedupe: require('../middleware/dedupe'),
  localNamingConventions: require('../middleware/localNamingConventions'),
  renamePlacenames: require('../middleware/renamePlacenames'),
  geocodeJSON: require('../middleware/geocodeJSON'),
  sendJSON: require('../middleware/sendJSON'),
  parseBoundingBox: require('../middleware/parseBBox')
};

/**
 * Append routes to app
 *
 * @param {object} app
 * @param {object} peliasConfig
 */
function addRoutes(app, peliasConfig) {

  var base = '/v1/';

  /** ------------------------- routers ------------------------- **/

  var routers = {
    index: createRouter([
      controllers.mdToHTML(peliasConfig, './public/apiDoc.md')
    ]),
    attribution: createRouter([
      controllers.mdToHTML(peliasConfig, './public/attribution.md')
    ]),
    search: createRouter([
      sanitisers.search.middleware,
      middleware.calcSize(),
      middleware.selectLanguage(peliasConfig),
      controllers.search(),
      postProc.matchLanguage(peliasConfig),
      postProc.distances('focus.point.'),
      postProc.confidenceScores(peliasConfig),
      postProc.dedupe(),
      postProc.localNamingConventions(),
      postProc.renamePlacenames(),
      postProc.parseBoundingBox(),
      postProc.geocodeJSON(peliasConfig, base),
      postProc.sendJSON
    ]),
    autocomplete: createRouter([
      sanitisers.autocomplete.middleware,
      middleware.selectLanguage(peliasConfig),
      controllers.search(null, require('../query/autocomplete')),
      postProc.matchLanguage(peliasConfig),
      postProc.distances('focus.point.'),
      postProc.confidenceScores(peliasConfig),
      postProc.dedupe(),
      postProc.localNamingConventions(),
      postProc.renamePlacenames(),
      postProc.parseBoundingBox(),
      postProc.geocodeJSON(peliasConfig, base),
      postProc.sendJSON
    ]),
    reverse: createRouter([
      sanitisers.reverse.middleware,
      middleware.calcSize(),
      middleware.selectLanguage(peliasConfig),
      controllers.search(undefined, reverseQuery),
      postProc.distances('point.'),
      // reverse confidence scoring depends on distance from origin
      //  so it must be calculated first
      postProc.confidenceScoresReverse(),
      postProc.dedupe(),
      postProc.localNamingConventions(),
      postProc.renamePlacenames(),
      postProc.parseBoundingBox(),
      postProc.geocodeJSON(peliasConfig, base),
      postProc.sendJSON
    ]),
    place: createRouter([
      sanitisers.place.middleware,
      middleware.selectLanguage(peliasConfig),
      controllers.place(),
      postProc.localNamingConventions(),
      postProc.renamePlacenames(),
      postProc.parseBoundingBox(),
      postProc.geocodeJSON(peliasConfig, base),
      postProc.sendJSON
    ]),
    status: createRouter([
      controllers.status
    ])
  };


  // static data endpoints
  app.get ( base,                  routers.index );
  app.get ( base + 'attribution',  routers.attribution );
  app.get (        '/attribution', routers.attribution );
  app.get (        '/status',      routers.status );

  // backend dependent endpoints
  app.get ( base + 'place',        routers.place );
  app.get ( base + 'autocomplete', routers.autocomplete );
  app.get ( base + 'search',       routers.search );
  app.post( base + 'search',       routers.search );
  app.get ( base + 'reverse',      routers.reverse );

}

/**
 * Helper function for creating routers
 *
 * @param {[{function}]} functions
 * @returns {express.Router}
 */
function createRouter(functions) {
  var router = Router(); // jshint ignore:line
  functions.forEach(function (f) {
    router.use(f);
  });
  return router;
}


module.exports.addRoutes = addRoutes;
