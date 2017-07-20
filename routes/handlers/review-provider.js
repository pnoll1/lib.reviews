'use strict';
// External dependencies
const config = require('config');

// Internal dependencies
const Review = require('../../models/review');
const Team = require('../../models/team');
const AbstractBREADProvider = require('./abstract-bread-provider');
const mlString = require('../../models/helpers/ml-string.js');
const urlUtils = require('../../util/url-utils');
const ReportedError = require('../../util/reported-error.js');
const md = require('../../util/md');
const slugs = require('../helpers/slugs');
const search = require('../../search');
const getJS = require('../../util/get-js');
const getMessages = require('../../util/get-messages');
const { getEditorMessageKeys } = require('../../frontend/editor-messages');
const { getAdapterMessageKeys } = require('../../frontend/adapters/adapter-messages');

class ReviewProvider extends AbstractBREADProvider {

  constructor(req, res, next, options) {

    super(req, res, next, options);
    this.actions.add.titleKey = 'new review';
    this.actions.edit.titleKey = 'edit review';
    this.actions.delete.titleKey = 'delete review';
    this.messageKeyPrefix = 'review';

    this.actions.addFromThing = {
      GET: this.addFromThing_GET,
      POST: this.add_POST,
      loadData: this.loadThing,
      titleKey: 'new review',
      preFlightChecks: [this.userIsSignedIn]
    };

    this.actions.addFromTeam = {
      GET: this.addFromTeam_GET,
      POST: this.addFromTeam_POST,
      loadData: this.loadTeam,
      titleKey: 'new review',
      preFlightChecks: [this.userIsSignedIn]
    };


  }

  read_GET(review) {

    let titleParam;
    if (review.thing) {
      if (review.thing.label)
        titleParam = mlString.resolve(this.req.locale, review.thing.label).str;
      else
        titleParam = urlUtils.prettify(review.thing.urls[0]);
    }

    // No permission checks on reads, so we have to do this manually
    review.populateUserInfo(this.req.user);

    this.renderTemplate('review', {
      titleKey: titleParam ? 'review of' : 'review',
      titleParam,
      deferPageHeader: true,
      review
    });

  }

  add_GET(formValues, thing) {

    let pageErrors = this.req.flash('pageErrors');
    let pageMessages = this.req.flash('pageMessages');
    let user = this.req.user;
    let showLanguageNotice = true;

    // For easier processing in the template
    if (formValues) {
      if (formValues.starRating)
        formValues.hasRating = {
          [formValues.starRating]: true
        };
      formValues.hasTeam = {};
      if (Array.isArray(formValues.teams))
        formValues.teams.forEach(team => (formValues.hasTeam[team.id] = true));
    }

    if (user.suppressedNotices &&
      user.suppressedNotices.indexOf('language-notice-review') !== -1)
      showLanguageNotice = false;

    this.renderTemplate('review-form', {
      formValues,
      titleKey: this.actions[this.action].titleKey,
      pageErrors: !this.isPreview ? pageErrors : undefined, // Don't show errors on preview
      isPreview: this.isPreview,
      preview: this.preview,
      scripts: ['review.js', getJS('editor')],
      showLanguageNotice,
      pageMessages,
      thing,
      editing: this.editing ? true : false
    }, {
      editing: this.editing ? true : false,
      messages: getMessages(this.req.locale,
        md.getMarkdownMessageKeys(),
        getEditorMessageKeys(),
        getAdapterMessageKeys(),
        ['more info']
      )
    });
  }

  addFromThing_GET(thing) {

    thing
      .getReviewsByUser(this.req.user)
      .then(reviews => {
        if (reviews.length) {
          this.req.flash('pageMessages', this.req.__('you already wrote a review'));
          return this.res.redirect(`/review/${reviews[0].id}/edit`);
        }
        this.add_GET(undefined, thing);
      })
      .catch(this.next);

  }

  addFromTeam_GET(team) {

    team.populateUserInfo(this.req.user);
    if (!team.userIsMember) {
      this.res.status(403);
      this.renderResourceError({
        titleKey: 'not a member of team title',
        bodyKey: 'not a member of team',
        bodyParam: `/team/${team.urlID}`
      });
    } else {
      let formValues = {
        teams: [team]
      };
      return this.add_GET(formValues);
    }

  }

  addFromTeam_POST(_team) {

    // Standard submission has checks against submitting from team you're not
    // a member of, so we don't have to check again here. The loaded team itself
    // will be passed along through the form, so we don't need to pass it here.
    return this.add_POST();

  }

  add_POST(thing) {

    this.isPreview = this.req.body['review-action'] == 'preview' ? true : false;

    let formKey = 'new-review';
    let language = this.req.body['review-language'];
    let formData = this.parseForm({
      formDef: ReviewProvider.formDefs[formKey],
      formKey,
      language,
      // We don't need a URL if we're adding a review to an existing thing
      skipRequiredCheck: thing && thing.id ? ['review-url'] : []
    });

    formData.formValues.createdBy = this.req.user.id;
    formData.formValues.createdOn = new Date();
    formData.formValues.originalLanguage = language;

    let reviewObj = Object.assign({}, formData.formValues);

    if (thing && thing.id)
      reviewObj.thing = thing;

    this
      .validateAndGetTeams(formData.formValues.teams)
      .then(teams => {

        // We're previewing or have basic problems with the submission -- back to form
        if (this.isPreview || this.req.flashHas('pageErrors')) {
          formData.formValues.creator = this.req.user; // Needed for username link
          formData.formValues.teams = teams;
          return this.add_GET(formData.formValues, thing);
        }

        reviewObj.teams = teams;

        Review
          .create(reviewObj, {
            tags: ['create-via-form']
          })
          .then(review => {
            this.req.app.locals.webHooks.trigger('newReview', {
              event: 'new-review',
              data: this.getWebHookData(review, this.req.user)
            });
            this.req.user.inviteLinkCount++;
            this.req.user
              .save()
              .then(() => {
                this.res.redirect(`/${review.thing.id}#your-review`);
                search.indexReview(review);
                search.indexThing(review.thing);
              })
              .catch(this.next); // Problem updating invite count
          })
          .catch(error => {
            this.req.flashError(error);
            this.add_GET(formData.formValues, thing);
          });

      })
      .catch(error => {
        if (error.name == 'DocumentNotFoundError' || error.name == 'RevisionDeletedError')
          error = new ReportedError({
            parentError: error,
            userMessage: 'submitted team could not be found'
          });

        this.req.flashError(error);
        this.add_GET(formData.formValues, thing);
      });

  }

  loadData() {

    return new Promise((resolve, reject) => {
      Review.getWithData(this.id).then(review => {
          // For permission checks on associated thing
          review.thing.populateUserInfo(this.req.user);
          resolve(review);
        })
        .catch(error => {
          reject(error);
        });
    });

  }

  loadThing() {

    // Ensure we show "thing not found" error if user tries to create
    // review from a nonexistent/stale/deleted thing
    this.messageKeyPrefix = 'thing';
    return slugs.resolveAndLoadThing(this.req, this.res, this.id);

  }

  loadTeam() {
    this.messageKeyPrefix = 'team';
    return slugs.resolveAndLoadTeam(this.req, this.res, this.id);
  }


  edit_GET(review) {

    this.editing = true;
    this.add_GET(review, review.thing);

  }

  edit_POST(review) {

    let formKey = 'edit-review';
    let language = this.req.body['review-language'];
    let formData = this.parseForm({
      formDef: ReviewProvider.formDefs[formKey],
      formKey,
      language
    });

    // We no longer accept URL edits if we're in edit-mode
    this.editing = true;

    if (this.req.body['review-action'] == 'preview') {
      // Pass along original authorship info for preview
      formData.formValues.createdOn = review.createdOn;
      formData.formValues.creator = review.creator;
      this.isPreview = true;
    }

    this
      .validateAndGetTeams(formData.formValues.teams)
      .then(teams => {
        // As with creation, back to edit form if we have errors or
        // are previewing
        if (this.isPreview || this.req.flashHas('pageErrors')) {
          formData.formValues.teams = teams;
          return this.add_GET(formData.formValues);
        }

        // Save the edit
        review
          .newRevision(this.req.user, {
            tags: ['edit-via-form']
          })
          .then(newRev => {
            let f = formData.formValues;
            newRev.title[language] = f.title[language];
            newRev.text[language] = f.text[language];
            newRev.html[language] = f.html[language];
            newRev.starRating = f.starRating;
            newRev.teams = teams;
            newRev.thing = review.thing;
            newRev
              .saveAll({ // Do not save changes to joined user
                teams: true,
                thing: true
              })
              .then(() => {
                search.indexReview(review);
                search.indexThing(review.thing);
                this.req.flash('pageMessages', this.req.__('edit saved'));
                this.res.redirect(`/review/${newRev.id}`);
              })
              .catch(error => {
                this.req.flashError(error);
                this.add_GET(formData.formValues);
              });
          })
          .catch(error => {
            this.req.flashError(error);
            this.add_GET(formData.formValues);
          });
      })
      .catch(error => {
        if (error.name == 'DocumentNotFoundError' || error.name == 'RevisionDeletedError')
          error = new ReportedError({
            parentError: error,
            userMessage: 'submitted team could not be found'
          });

        this.req.flashError(error);
        this.add_GET(formData.formValues);
      });

  }

  validateAndGetTeams(teamObj) {

    return new Promise((resolve, reject) => {

      if (typeof teamObj !== 'object' || !Object.keys(teamObj).length)
        return resolve([]);

      let p = [];
      for (let id in teamObj)
        p.push(Team.getWithData(id));

      Promise
        .all(p)
        .then(teams => {

          teams.forEach(team => {
            team.populateUserInfo(this.req.user);
            if (!team.userIsMember)
              throw new ReportedError({
                userMessage: 'user is not member of submitted team'
              });
          });
          resolve(teams);

        })
        .catch(error => reject(error));
    });

  }

  delete_GET(review) {
    let pageErrors = this.req.flash('pageErrors');

    this.renderTemplate('delete-review', {
      review,
      pageErrors
    });
  }

  delete_POST(review) {
    let withThing = this.req.body['delete-thing'] ? true : false;
    this.parseForm({
      formDef: ReviewProvider.formDefs['delete-review'],
      formKey: 'delete-review'
    });

    // Trying to delete recursively, but can't!
    if (withThing && !review.thing.userCanDelete)
      return this.renderPermissionError({
        titleKey: this.actions[this.action].titleKey
      });

    if (this.req.flashHas('pageErrors'))
      return this.delete_GET(review);

    let deleteFunc = withThing ?
      review.deleteAllRevisionsWithThing :
      review.deleteAllRevisions;

    Reflect.apply(deleteFunc, review, [this.req.user])
      .then(() => {
        this.renderTemplate('review-deleted', {
          titleKey: 'review deleted'
        });
        search.deleteReview(review);
        if (withThing)
          search.deleteThing(review.thing);
      })
      .catch(this.next);
  }

  // Return data for easy external processing after publication, e.g. via IRC
  // feeds
  getWebHookData(review, user) {

    return {
      title: review.title,
      thingURLs: review.thing.urls,
      thingLabel: review.thing.label,
      starRating: review.starRating,
      html: review.html,
      text: review.text,
      createdOn: review.createdOn,
      author: user.displayName,
      reviewURL: `${config.qualifiedURL}review/${review.id}`,
      thingURL: `${config.qualifiedURL}thing/${review.thing.id}`,
      authorURL: `${config.qualifiedURL}user/${user.urlName}`
    };

  }

}

module.exports = ReviewProvider;


// Shared across instances
ReviewProvider.formDefs = {
  'new-review': [{
      name: 'review-url',
      required: true,
      type: 'url',
      key: 'url'
    }, {
      name: 'review-title',
      required: true,
      type: 'text',
      key: 'title'
    },
    {
      name: 'review-label',
      required: false,
      type: 'text',
      key: 'label'
    },
    {
      name: 'review-text',
      required: true,
      type: 'markdown',
      key: 'text',
      flat: true,
      htmlKey: 'html'
    }, {
      name: 'review-rating',
      required: true,
      type: 'number',
      key: 'starRating'
    }, {
      name: 'review-language',
      required: false,
      key: 'originalLanguage'
    }, {
      name: 'review-action',
      required: true,
      skipValue: true // Logic, not saved
    },
    {
      name: 'review-team-%uuid',
      required: false,
      type: 'boolean',
      keyValueMap: 'teams'
    }
  ],
  'delete-review': [{
    name: 'delete-action',
    required: true
  }, {
    name: 'delete-thing',
    required: false
  }],
  'edit-review': [{
      name: 'review-title',
      required: true,
      type: 'text',
      key: 'title'
    }, {
      name: 'review-text',
      required: true,
      type: 'markdown',
      key: 'text',
      flat: true,
      htmlKey: 'html'
    }, {
      name: 'review-rating',
      required: true,
      type: 'number',
      key: 'starRating'
    }, {
      name: 'review-language',
      required: true
    }, {
      name: 'review-action',
      required: true,
      skipValue: true
    },
    {
      name: 'review-team-%uuid',
      required: false,
      type: 'boolean',
      keyValueMap: 'teams'
    }
  ]
};
