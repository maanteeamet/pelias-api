
/**
 *
 * Basic confidence score should be computed and returned for each item in the results.
 * The score should range between 0-1, and take into consideration as many factors as possible.
 *
 * Some factors to consider:
 *
 * - number of results from ES
 * - score of item within the range of highest-lowest scores from ES (within the returned set)
 * - linguistic match of query
 * - detection (or specification) of query type. i.e. an address shouldn't match an admin address.
 */

var stats = require('stats-lite');
var logger = require('pelias-logger').get('api');
var check = require('check-types');
var _ = require('lodash');
var fuzzy = require('../helper/fuzzyMatch');

var RELATIVE_SCORES = false;

var languages = ['default'];
var adminProperties;
var minConfidence=0, relativeMinConfidence;

// default configuration for address confidence check
var confidenceAddressParts = {
  number: { parent: 'address_parts', field: 'number', enrich: false, numeric: true, weight: 1 },
  street: { parent: 'address_parts', field: 'street', enrich: true, numeric: false, weight: 2 },
  postalcode: { parent: 'address_parts', field: 'zip', enrich: true, numeric: false, weight: 3 },
  state: { parent: 'parent', field: 'region_a', enrich: true, numeric: false, weight: 4},
  country: { parent: 'parent', field: 'country_a', enrich: true, numeric: false, weight:5 }
};

function setup(peliasConfig) {
  if (check.assigned(peliasConfig)) {
    RELATIVE_SCORES = peliasConfig.hasOwnProperty('relativeScores') ? peliasConfig.relativeScores : true;
    if (peliasConfig.languages) {
      languages = _.uniq(languages.concat(peliasConfig.languages));
    }
    if(peliasConfig.minConfidence) {
      minConfidence = peliasConfig.minConfidence;
    }
    relativeMinConfidence = peliasConfig.relativeMinConfidence;
    var localization = peliasConfig.localization;
    if (localization) {
      if(localization.confidenceAdminProperties) {
        adminProperties = localization.confidenceAdminProperties;
      }
      if(localization.confidenceAddressParts) {
        confidenceAddressParts = localization.confidenceAddressParts;
      }
    }
  }
  return computeScores;
}


function compareProperty(p1, p2) {
  if (Array.isArray(p1)) {
    p1 = p1[0];
  }
  if (Array.isArray(p2)) {
    p2 = p2[0];
  }

  if (!p1 || !p2) {
    return 0;
  }
  if (typeof p1 === 'string'){
    p1 = p1.toLowerCase();
  }
  if (typeof p2 === 'string'){
    p2 = p2.toLowerCase();
  }
  return (p1<p2?-1:(p1>p2?1:0));
}


/* Quite heavily fi specific sorting */
function compareResults(a, b) {
  if (b.confidence !== a.confidence) {
    return b.confidence - a.confidence;
  }
  var diff;
  if (a.parent && b.parent) {
    diff = compareProperty(a.parent.localadmin, b.parent.localadmin);
    if (diff) {
      return diff;
    }
  }
  if (a.address_parts && b.address_parts) {
    diff = compareProperty(a.address_parts.street, b.address_parts.street);
    if (diff) {
      return diff;
    }

    var n1 = parseInt(a.address_parts.number);
    var n2 = parseInt(b.address_parts.number);
    if (!isNaN(n1) && !isNaN(n2)) {
      diff = compareProperty(n1, n2);
      if (diff) {
        return diff;
      }
    }
  }
  if (a.name && b.name) {
    diff = compareProperty(a.name.default, b.name.default);
    if (diff) {
      return diff;
    }
  }

  return 0;
}

function computeScores(req, res, next) {
  // do nothing if no result data set
  if (!check.assigned(req.clean) || !check.assigned(res) ||
      !check.assigned(res.data) || res.data.length===0 || !check.assigned(res.meta)) {
    return next();
  }

  // compute standard deviation and mean from all scores
  var scores = res.meta.scores;
  var stdev = computeStandardDeviation(scores);
  var mean = stats.mean(scores);

  // loop through data items and determine confidence scores
  res.data = res.data.map(computeConfidenceScore.bind(null, req, mean, stdev));

  res.data.sort(compareResults);

  var bestConfidence = res.data[0].confidence;
  var limit = minConfidence;
  if(relativeMinConfidence) {
    limit = Math.max(limit, relativeMinConfidence * bestConfidence);
  }
  res.data = res.data.filter(function(doc) {
    return(doc.confidence>limit);
  });

  next();
}

/**
 * Check all types of things to determine how confident we are that this result
 * is correct. Score is based on overall score distribution in the result set
 * as well as how closely the result matches the text parameters.
 *
 * @param {object} req
 * @param {number} mean
 * @param {number} stdev
 * @param {object} hit
 * @returns {object}
 */
function computeConfidenceScore(req, mean, stdev, hit) {
/*
  var dealBreakers = checkForDealBreakers(req, hit);
  if (dealBreakers) {
    hit.confidence = 0.1;
    return hit;
  }
*/
/*
  if (RELATIVE_SCORES) {
    checkCount += 2;
    hit.confidence += checkDistanceFromMean(hit._score, mean, stdev);
    hit.confidence += computeZScore(hit._score, mean, stdev);
  }
*/

/*
    hit.confidence += checkQueryType(parsedText, hit);
    checkCount += 1;
*/

  hit.confidence = 0;
  var checkCount = 0;
  var parsedText = req.clean.parsed_text;
  var doAddressCheck;
  var adminConfidence;

  if (parsedText) {
    // first compare address if parsed text has any elements for it
    for(var key in confidenceAddressParts) {
      if(check.assigned(parsedText[key])) {
        doAddressCheck = true;
      }
    }
    if(doAddressCheck) {
      hit.confidence += checkAddress(parsedText, hit);
      checkCount++;
    }

    if(adminProperties && parsedText.regions && parsedText.regions.length) {
      adminConfidence = checkRegions(parsedText, hit);
    }
  }

  // compare parsed name (or raw text) against configured language
  // versions of name and possibly street
  var doNameCheck=true;
  if(doAddressCheck && parsedText.street) {
    // address check already done
    // do not rescore name if it duplicates the address
    var name1 = parsedText.street;
    var name2 = name1;

    if(check.assigned(parsedText.number)) {
      name1 = name1 + ' ' + parsedText.number;
      name2 = parsedText.number + ' ' + name2;
    }
    var input = parsedText.name || req.clean.text.toLowerCase();

    if(input === name1 || input === name2) {
      doNameCheck=false;
      logger.debug(' @ skip name check');
    }
  }
  if(doNameCheck) {
    hit.confidence += checkName(req.clean.text, parsedText, hit);
    checkCount++;
  }

  // keep admin scoring proportion constant 50%
  // regardless of count of finer scores
  if(check.assigned(adminConfidence)) {
    hit.confidence += checkCount*adminConfidence;
    checkCount*=2;
  }
  // TODO: look at categories and location

  hit.confidence /= checkCount;
  logger.debug('### confidence', hit.confidence);

  return hit;
}

/*
 * Check for clearly mismatching properties in a result
 * zip code and state (region) are currently checked if present
 *
 * @param {object|undefined} text
 * @param {object} hit
 * @returns {bool}
 */
function checkForDealBreakers(req, hit) {
  if (!check.assigned(req.clean.parsed_text)) {
    return false;
  }

  if (check.assigned(req.clean.parsed_text.state) && hit.parent.region_a && req.clean.parsed_text.state !== hit.parent.region_a[0]) {
    logger.debug('[confidence][deal-breaker]: state !== region_a');
    return true;
  }

  if (check.assigned(req.clean.parsed_text.postalcode) && check.assigned(hit.address_parts) &&
      req.clean.parsed_text.postalcode !== hit.address_parts.zip) {
    return true;
  }
}

/**
 * Check how statistically significant the score of this result is
 * given mean and standard deviation
 *
 * @param {number} score
 * @param {number} mean
 * @param {number} stdev
 * @returns {number}
 */
function checkDistanceFromMean(score, mean, stdev) {
  return (score - mean) > stdev ? 1 : 0;
}

/**
 * Compare text string against configuration defined language versions of a property
 *
 * @param {string} text
 * @param {object} property with language versions
 * @returns {bool}
 */

function checkLanguageProperty(text, propertyObject, stripNumbers) {
  var bestScore = 0;
  var bestName;

  for (var lang in propertyObject) {
    if (languages.indexOf(lang) === -1) {
      continue;
    }
    var score;

    if(stripNumbers) {
      score = fuzzy.match(text, propertyObject[lang].replace(/[0-9]/g, '').trim());
    } else {
      score = fuzzy.match(text, propertyObject[lang]);
    }

    if (score > bestScore ) {
      bestScore = score;
      bestName = propertyObject[lang];
    }
  }
  logger.debug('name score', bestScore, text, bestName);

  return bestScore;
}

/**
 * Compare text string or name component of parsed_text against
 * default name in result
 * Note: consider also street here as it often stores searched name
 *
 * @param {string} text
 * @param {object|undefined} parsed_text
 * @param {object} hit
 * @returns {number}
 */
function checkName(text, parsed_text, hit) {

  var checkParsed = function(parsed, hit) {
    var score = checkLanguageProperty(parsed, hit.name);

    // check also street property
    if(check.assigned(hit.address_parts) && check.assigned(hit.address_parts.street)) {
      var _score = propMatchArray(parsed, hit.address_parts.street, true);
      if (_score>score) {
        score=_score;
      }
    }
    return score;
  };

  // parsed_text name should take precedence if available since it's the cleaner name property
  if (check.assigned(parsed_text) && check.assigned(parsed_text.name)) {
    return(checkParsed(parsed_text.name, hit));
  }

  // if no parsed_text check the full unparsed text value
  return(checkParsed(text, hit));
}

/**
 * text.number being set indicates the query was for an address
 * check if house number was specified and found in result
 *
 * @param {object|undefined} text
 * @param {object} hit
 * @returns {number}
 */
function checkQueryType(text, hit) {
  if (check.assigned(text) && check.assigned(text.number) &&
      (!check.assigned(hit.address_parts) ||
      (check.assigned(hit.address_parts) && !check.assigned(hit.address_parts.number)))) {
    return 0;
  }
  return 1;
}

/**
 * Determine the quality of the property match
 *
 * @param {string|number|undefined|null} textProp
 * @param {string|number|undefined|null} hitProp
 * @param {boolean} expectEnriched
 * @returns {number}
 */
function propMatch(textProp, hitProp, expectEnriched, numeric) {

  // both missing = match
  if (!check.assigned(textProp) && !check.assigned(hitProp)) {
    if (expectEnriched) { return 0.5; }
    else { return 1; } // no enrichment expected => GOOD
  }

  // text has it, result missing
  if (check.assigned(textProp) && !check.assigned(hitProp)) {
    if (expectEnriched) { return 0.2; }
    else { return 0.5; }
  }

  // text missing, result has it
  if (!check.assigned(textProp) && check.assigned(hitProp)) {
    if (!expectEnriched) { return 0.5; } // enrichment not desired
    return 1.0;
  }

  // both present
  if (numeric) {
    if(textProp === hitProp) {
      // handle exact match before dropping all but numeric part
      return 1.0;
    }
    var n1 = parseInt(textProp);
    var n2 = parseInt(hitProp);
    if (!isNaN(n1) && !isNaN(n2)) {
      var match = 0.9/(1.0 + Math.abs(n1-n2));
      return match;
    }
  }

  return fuzzy.match(textProp.toString(), hitProp.toString());
}

// array wrapper for function above
function propMatchArray(text, hitProp, expectEnriched, numeric) {
  if (Array.isArray(hitProp)) { // check all array values
    var count = hitProp.length;
    var maxMatch = 0;
    for (var i=0; i<count; i++) {
      var match = propMatch(text, hitProp[i], expectEnriched, numeric);
      if (match>maxMatch) {
        maxMatch=match;
      }
    }
    return maxMatch;
  } else {
    return propMatch(text, hitProp, expectEnriched, numeric);
  }
}


/**
 * Check various parts of the parsed text address
 * against the results
 *
 * @param {object} text
 * @param {string|number} [text.number]
 * @param {string} [text.street]
 * @param {string} [text.postalcode]
 * @param {string} [text.state]
 * @param {string} [text.country]
 * @param {object} hit
 * @param {object} [hit.address_parts]
 * @param {string|number} [hit.address_parts.number]
 * @param {string} [hit.address_parts.street]
 * @param {string|number} [hit.address_parts.zip]
 * @param {Array} [hit.parent.region_a]
 * @param {Array} [hit.parent.country_a]
 * @returns {number}
 */
function checkAddress(text, hit) {
  var res = 0;
  var checkCount = 0;

  for(var key in confidenceAddressParts) {
    var value;
    var part = confidenceAddressParts[key];
    var parent = hit[part.parent];

    if(!text[key] && part.enrich) { // do not score unless enrichment is undesired
      continue;
    }

    if (!parent) {
      value = null;
    } else {
      value = parent[part.field];
    }
    var score = propMatchArray(text[key], value, part.enrich, part.numeric);

    if(key==='street' && text[key]) { // special case: proper version can be stored in the name
      var _score = checkLanguageProperty(text[key], hit.name, true);
      if(_score>score) {
        score = _score;
      }
    }
    res += score*part.weight;
    checkCount += part.weight;
  }
  res /= checkCount;

  logger.debug('address match', res);

  return res;
}


/**
 * Check admin properties against parsed values
 *
 * @param {values} text/array
 * @param {object} hit
 * @param {object} [hit.parent]
 * @returns {number}
 */
function checkAdmin(values, hit) {
  if (!Array.isArray(values)) {
    values = [values];
  }

  // loop trough configured properties to find best match
  var bestMatch = 0;

  var updateBest = function(text) {
    var match = fuzzy.matchArray(text, values);
    if (match>bestMatch) {
      bestMatch = match;
    }
  };

  adminProperties.forEach( function(key) {
    var prop = hit.parent[key];
    if (prop) {
      if (Array.isArray(prop)) {
        prop.forEach(updateBest);
      } else {
        updateBest(prop);
      }
    }
  });
  return bestMatch;
}


/**
 * Check admin regions of the parsed text against a result.
 *
 * @param {object} text
 * @param {object} [text.regions]
 * @param {object} hit
 * @param {object} [hit.parent]
 * @returns {number}
 */
function checkRegions(text, hit) {
  var regions = [];
  var source = text.regions;

  for(var i=1; i<source.length; i++) { // drop 1st entry = actual name or street
    regions.push(source[i]);
  }

  var bestMatch = checkAdmin(text.regions, hit);
  logger.debug('admin match', bestMatch);

  return bestMatch;
}

/**
 * Check city of the parsed text against a result.
 *
 * @param {string} city
 * @param {object} hit
 * @param {object} [hit.parent]
 * @returns {number}
 */
function checkCity(city, hit) {

  var bestMatch = checkAdmin(city, hit);
  logger.debug('city match', bestMatch);

  return bestMatch;
}

/**
 * z-scores have an effective range of -3.00 to +3.00.
 * An average z-score is ZERO.
 * A negative z-score indicates that the item/element is below
 * average and a positive z-score means that the item/element
 * in above average. When teachers say they are going to 'curve'
 * the test, they do this by computing z-scores for the students' test scores.
 *
 * @param {number} score
 * @param {number} mean
 * @param {number} stdev
 * @returns {number}
 */
function computeZScore(score, mean, stdev) {
  if (stdev < 0.01) {
    return 0;
  }
  // because the effective range of z-scores is -3.00 to +3.00
  // add 10 to ensure a positive value, and then divide by 10+3+3
  // to further normalize to %-like result
  return (((score - mean) / (stdev)) + 10) / 16;
}

/**
 * Computes standard deviation given an array of values
 *
 * @param {Array} scores
 * @returns {number}
 */
function computeStandardDeviation(scores) {
  var stdev = stats.stdev(scores);
  // if stdev is low, just consider it 0
  return (stdev < 0.01) ? 0 : stdev;
}


module.exports = setup;
