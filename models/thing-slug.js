'use strict';
const thinky = require('../db');
const r = thinky.r;
const type = thinky.type;

// Model for unique, human-readable identifiers ('slugs') for review subjects
// ('things')

let thingSlugSchema = {
  name: type.string().max(125),

  baseName: type.string().max(100),
  qualifierPart: type.string().max(25),

  thingID: type.string().uuid(4),
  createdOn: type.date(),
  createdBy: type.string().uuid(4)
};

let ThingSlug = thinky.createModel("thing_slugs", thingSlugSchema, {
  pk: 'name'
});

ThingSlug.ensureIndex("createdOn");

ThingSlug.define("qualifiedSave", function() {
  let slug = this;
  return new Promise((resolve, reject) => {
    slug.baseName = slug.name; // Store base name for later reference
    this
      .save()
      .then(resolve)
      .catch(error => {
        if (error.name === 'DuplicatePrimaryKeyError') {

          // Check first if we've used this base name before for this ID
          ThingSlug
            .filter({
              baseName: slug.name,
              thingID: slug.thingID
            })
            .orderBy(r.desc('createdOn'))
            .limit(1)
            .then(slugs => {
              if (slugs.length)
                // Got a match, no need to save -- just pass it along
                return resolve(slugs[0]);
              // Widen search for most recent use of this base name
              else {
                ThingSlug
                  .filter({
                    baseName: slug.name
                  })
                  .orderBy(r.desc('createdOn'))
                  .limit(1)
                  // We need to generate a new qualifier to disambiguate this slug
                  .then(slugs => {
                    let latestQualifier;
                    if (slugs.length && !isNaN(Number(slugs[0].qualifierPart))) {
                      latestQualifier = Number(slugs[0].qualifierPart) + 1;
                    } else {
                      latestQualifier = 2;
                    }
                    slug.name = slug.name + '-' + String(latestQualifier);
                    slug.qualifierPart = String(latestQualifier);
                    slug
                      .save()
                      .then(resolve)
                      .catch(reject);
                  })
                  .catch(reject);
              }
            })
            .catch(reject);
        } else
          reject(error);
      });

  });
});


module.exports = ThingSlug;
