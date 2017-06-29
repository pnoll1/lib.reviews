'use strict';

// External dependencies
const express = require('express');
const router = express.Router();

// Internal dependencies
const User = require('../models/user');
const Thing = require('../models/thing');
const actionHandler = require('./handlers/action-handler');
const search = require('../search');
const urlUtils = require('../util/url-utils');

// For true/false user preferences.
router.post('/actions/:modify-preference', actionHandler.modifyPreference);

router.post('/actions/suppress-notice', actionHandler.suppressNotice);


// Query existence/properties of a thing (review subject)
// look up by canonical URL name via /thing/:label or use URL query parameter
// e.g., ?url=http://yahoo.com
router.get('/thing', function(req, res, next) {
  if (req.query.url) {
    let rv = {},
      failureMsg = 'Could not retrieve review subject.';

    if (!urlUtils.validate(req.query.url)) {
      rv.message = failureMsg;
      rv.errors = ['URL is not valid.'];
      res.status(400);
      res.type('json');
      res.send(JSON.stringify(rv, null, 2));
      return;
    }

    Thing
      .lookupByURL(urlUtils.normalize(req.query.url))
      .then(result => {
        if (!result.length) {
          res.status(404);
          rv.message = failureMsg;
          rv.errors = ['URL not found.'];
          res.type('json');
          res.send(JSON.stringify(rv, null, 2));
        } else {
          result = result[0];
          result
            .populateReviewMetrics()
            .then(() => {
              res.status(200);
              rv.thing = {
                id: result.id,
                label: result.label,
                aliases: result.aliaes,
                description: result.description,
                originalLanguage: result.originalLanguage,
                canonicalSlugName: result.canonicalSlugName,
                urlID: result.urlID,
                createdOn: result.createdOn,
                createdBy: result.createdBy,
                numberOfReviews: result.numberOfReviews,
                averageStarRating: result.averageStarRating,
                urls: result.urls
              };
              res.type('json');
              res.send(JSON.stringify(rv, null, 2));
            })
            .catch(next);
        }
      })
      .catch(next);
  }
});

// Search suggestions
router.get('/suggest/thing/:prefix', function(req, res, next) {
  let prefix = req.params.prefix.trim();
  search
    .suggestThing(prefix, req.locale)
    .then(results => {
      let rv = {};

      // Simplify ElasticSearch result structure for API use (flatten, strip
      // metadata; strip unneeded source data)
      rv.results = results.suggest;
      for (let k in rv.results) {
        rv.results[k] = rv.results[k][0].options;
        for (let option of rv.results[k]) {
          option.urlID = option._source.urlID;
          option.urls = option._source.urls;
          Reflect.deleteProperty(option, '_source');
          Reflect.deleteProperty(option, '_index');
        }
      }

      res.type('json');
      res.status(200);
      res.send(JSON.stringify(rv, null, 2));
    })
    .catch(next);
});

router.get('/user/:name', function(req, res) {
  let name = req.params.name.trim();
  let rv = {};
  User.filter({
    canonicalName: User.canonicalize(name)
  }).then(result => {
    if (result.length) {
      let user = result[0];
      rv.id = user.id;
      rv.displayName = user.displayName;
      rv.canonicalName = user.canonicalName;
      rv.registrationDate = user.registrationDate;
      rv.isSiteModerator = user.isSiteModerator;
      res.status(200);
    } else {
      rv.message = 'Could not retrieve user data.';
      rv.errors = ['User does not exist.'];
      res.status(404);
    }
    res.type('json');
    res.send(JSON.stringify(rv, null, 2));
  });
});

module.exports = router;
