/* global $, AC, config, libreviews */
'use strict';

// This module performs shallow lookups on Wikidata. They are shallow in that
// they only load the information that needs to be displayed to the user in
// their current language. The backend version of this adapter performs the
// actual deep lookup for all languages.

// Internal deps

const AbstractFrontendAdapter = require('./abstract-frontend-adapter');


// Adapter settings
const supportedPattern = new RegExp('http(s)*://(www.)*wikidata.org/(entity|wiki)/(Q\\d+)$', 'i');
const apiBaseURL = 'https://www.wikidata.org/w/api.php';
const sourceID = 'wikidata';

// Because we use a blacklist to exclude certain results (e.g., disambiguation
// pages), we fetch a larger number of results than we may need, since we may
// eliminate some of them client-side. The ratio below has proven to strike a
// good balance where few queries result in zero "good" results.
const fetchResults = 25;
const displayResults = 7;

// How do lib.reviews language code translate to Wikidata language codes?
// Since Wikidata supports a superset of languages and most language codes
// are identical, we only enumerate exceptions.
const nativeToWikidata = {
  pt: 'pt-br',
  'pt-PT': 'pt'
};

// Even when selecting via search, we still want to check whether there's a
// native entry for this URL
const NativeFrontendAdapter = require('./native-frontend-adapter');
const nativeFrontendAdapter = new NativeFrontendAdapter();

// See abstract-adapter.js for method documentation.
class WikidataFrontendAdapter extends AbstractFrontendAdapter {

  ask(url) {
    return supportedPattern.test(url);
  }

  lookup(url) {
    return new Promise((resolve, reject) => {
      let qNumber = (url.match(supportedPattern) || [])[4];
      if (!qNumber)
        return reject(new Error('URL does not appear to contain a Q number (e.g., Q42) or is not a Wikidata URL.'));

      // in case the URL had a lower case "q"
      qNumber = qNumber.toUpperCase();

      const language = nativeToWikidata[config.language] || config.language;

      let queryObj = {
        action: 'wbgetentities',
        format: 'json',
        languages: language,
        uselang: language,
        languagefallback: 1,
        props: 'labels|descriptions',
        ids: qNumber
      };

      $.ajax({
          url: apiBaseURL,
          jsonp: 'callback',
          dataType: 'jsonp',
          data: queryObj
        })
        .done(data => {
          if (typeof data !== 'object' || !data.success || !data.entities || !data.entities[qNumber])
            return reject(new Error('Did not get a valid Wikidata entity for query: ' + qNumber));

          const entity = data.entities[qNumber];
          // Descriptions result will be an empty object if no description is available, so
          // will always pass this test
          if (!entity.labels || !entity.descriptions)
            return reject(new Error('Did not get label and description information for query: ' + qNumber));

          if (!entity.labels[language])
            return reject(new Error('Did not get a label for ' + qNumber + 'for the specified language: ' + language));

          let label = entity.labels[language].value,
            description;

          if (entity.descriptions[language])
            description = entity.descriptions[language].value;

          resolve({
            data: {
              label,
              description
            },
            sourceID
          });
        })
        .fail(reject);
    });
  }

  setup() {

    const self = this;

    // Wire up switcher for source of review subject
    $('#review-via-url').conditionalSwitcherClick(function() {
      $('#review-via-wikidata-inputs').addClass('hidden');
      $('#review-via-url-inputs').removeClass('hidden');
      $('.review-label-group').removeClass('hidden-regular');
      if (!$('#review-url').val())
        $('#review-url').focus();
    });

    $('#review-via-wikidata').conditionalSwitcherClick(function(event) {
      // Does not conflict with other hide/show actions on this group
      $('.review-label-group').addClass('hidden-regular');
      $('#review-via-url-inputs').addClass('hidden');
      $('#review-via-wikidata-inputs').removeClass('hidden');
      // Focusing pops the selection back up, so this check is extra important here
      if (!$('#review-search-wikidata').val())
        $('#review-search-wikidata').focus();
      // Suppress event bubbling up to window, which the AC widget listens to, and
      // which would unmount the autocomplete function
      event.stopPropagation();
    });

    const searchBoxSelector = '#review-search-wikidata';


    // We exclude certain meta-content (e.g., Wikimedia disambiguation pages)
    // by testing descriptions against a blacklist. This is different for
    // each language, and loaded from a UI message, which gets parsed into
    // regular expressions.
    const blacklist = config.messages['wikidata title blacklist']
      .split('\n')
      .filter(entry => typeof entry === 'string' && entry.length) // Ignore empty lines
      .map(entry => new RegExp(entry));

    // `this` refers to adapter
    const triggerFn = row => {
      if (row.url && row.label) {
        // Perform appropriate UI updates
        this.updateCallback(row);
        // Check if we have local record and if so, replace Wikidata lookup
        // results
        nativeFrontendAdapter
          .lookup(row.url)
          .then(result => {
            if (result && result.data) {
              result.data.url = row.url;
              this.updateCallback(result.data);
            }
          })
          .catch(() => {
            // Do nothing
          });
      }
    };

    // `this` refers to AC instance
    function requestFn(query, requestedOffset) {
      const time = Date.now();

      // Keep track of most recently fired query so we can ignore responses
      // coming in late
      if (this.latestQuery === undefined || this.latestQuery < time)
        this.latestQuery = time;

      this.results = [];
      query = query.trim();

      // Nothing to do - clear out the display & abort
      if (!query) {
        // Turn off spinner
        $(`${searchBoxSelector} + span.input-spinner`).addClass('hidden');
        return this.render();
      }

      // Turn on spinner
      $(`${searchBoxSelector} + span.input-spinner`).removeClass('hidden');

      const language = nativeToWikidata[config.language] || config.language;

      let queryObj = {
        action: 'wbsearchentities',
        search: query,
        language,
        uselang: language,
        format: 'json',
        limit: fetchResults
      };

      // Track if this is the first page we're rendering, in which case there's
      // no "previous" button
      let isFirstPage;

      if (requestedOffset) {
        // Pass along the offset
        queryObj.continue = requestedOffset;
      } else {
        isFirstPage = true;
        // Keep track of the exact offsets used on previous pages, since
        // they vary due to client-side filtering
        this.prevStack = [];
      }

      $.ajax({
          url: apiBaseURL,
          jsonp: 'callback',
          dataType: 'jsonp',
          data: queryObj
        })
        .done(data => {
          // Don't update if a more recent query has superseded this one
          if (time < this.latestQuery)
            return;

          // Turn off spinner
          $(`${searchBoxSelector} + span.input-spinner`).addClass('hidden');

          this.results = [];

          // Keep track of how many results we get that we can use (that don't
          // match a blacklist)
          let goodResults = 0;
          // Keep track of where in the result set we want to continue from
          let resultIndex = 0;

          if (typeof data === 'object' && data.search) {

            // Client-side filtering of results per blacklist
            itemloop: for (let item of data.search) {
              resultIndex++;
              if (blacklist.length) {
                for (let regex of blacklist)
                  if (regex.test(item.description))
                    continue itemloop;
              }
              let result = {};
              result.url = self.canonicalize(item.concepturi);
              // Modified below
              result.title = item.label;
              // We preserve the original label
              result.label = item.label;
              result.description = item.description;
              // Result does not contain query string directly, but some part of
              // match does. Following example of Wikidata.org search box,
              // append match to result.
              if (item.label && item.label.toUpperCase().indexOf(query.toUpperCase()) === -1)
                result.title += ` (${item.match.text})`;
              else if (!item.label)
                result.title = item.match.text;

              this.results.push(result);
              goodResults++;

              if (goodResults >= displayResults)
                break;
            }
            this.render();


            // Navigation templates
            const $navPlaceholder = $('<div class="ac-adapter-get-prev">&nbsp;</div>'),
              $navWrapper = $('<div class="ac-adapter-get-more"></div>'),
              $navMoreResultsText = $('<div class="ac-adapter-more-results">' + libreviews.msg('more results') + '</div>'),
              $navNoResultsText = $('<div class="ac-adapter-no-relevant-results">' + libreviews.msg('no relevant results') + '</div>'),
              $navPreviousPage = $('<div accesskey="<" class="ac-adapter-get-prev ac-adapter-get-active" title="' + libreviews.msg('load previous page', { accessKey: '<' }) + '"><span class="fa fa-caret-left">&nbsp;</span></div>'),
              $navNextPage = $('<div class="ac-adapter-get-next ac-adapter-get-active" accesskey=">" title="' + libreviews.msg('load next page', { accessKey: '>' }) + '"><span class="fa fa-caret-right">&nbsp;</span></div>');

            // The API only returns the 'search-continue' offset up to the 50th
            // result. It is useful only in edge cases but we track it for those.
            let apiSaysMoreResults = data['search-continue'] !== undefined;
            let weKnowAboutMoreResults = data.search.length > goodResults;
            let hasPagination = !isFirstPage || apiSaysMoreResults || weKnowAboutMoreResults;

            let $getMore,
              $wrapper = $(this.rowWrapperEl);


            // Add basic pagination template
            if (hasPagination) {
              $getMore = $navWrapper.appendTo($wrapper);
              // Show "no relevant results" text
              if (goodResults === 0)
                $wrapper
                .prepend($navNoResultsText)
                .show();
            }

            // Add "previous page" navigation
            if (!isFirstPage) {
              $navPreviousPage
                .appendTo($getMore)
                .click(() => this.requestFn(query, this.prevStack.pop()));
            }

            if (apiSaysMoreResults || weKnowAboutMoreResults) {
              let nextOffset = (requestedOffset || 0) + resultIndex;

              // Add whitespace placeholder
              if (isFirstPage)
                $navPlaceholder
                .appendTo($getMore);

              // Add "MORE RESULTS" centered text
              $navMoreResultsText
                .appendTo($getMore);

              // Add "next page" navigation
              $navNextPage
                .appendTo($getMore)
                .click(() => {
                  this.prevStack.push(requestedOffset);
                  this.requestFn(query, nextOffset);
                });
            } else if (!isFirstPage) {
              // Add "MORE RESULTS" centered text
              $navMoreResultsText
                .appendTo($getMore);
            }
          }
        })
        .fail(_error => {
          // Show generic error
          $('#generic-action-error').removeClass('hidden');
          window.libreviews.repaintFocusedHelp();
          // Turn off spinner
          $(`${searchBoxSelector} + span.input-spinner`).addClass('hidden');
        });
    }
    let ac = new AC($(searchBoxSelector)[0], null, requestFn, null, null, triggerFn);
    ac.secondaryTextKey = 'description';
    ac.delay = 0;
    ac.cssPrefix = 'ac-adapter-';
  }

  // Transforms HTTP to HTTPS, and switches from the /entity to the /wiki
  // format, since the latter is the one users are likely to copy/paste.
  canonicalize(url) {
    return url.replace(/^http:/g, 'https:').replace(/\/entity\//, '/wiki/');
  }

}

module.exports = WikidataFrontendAdapter;
