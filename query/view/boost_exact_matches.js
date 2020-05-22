const peliasQuery = require('pelias-query');
const searchDefaults = require('../search_defaults');

/**
  This view (unfortunately) requires autocomplete to use the phrase.* index.

  ideally we wouldn't need to use this, but at time of writing we are unable
  to distinguish between 'complete tokens' and 'grams' in the name.* index.

  this view was introduced in order to score exact matches higher than partial
  matches, without it we find results such as "Clayton Avenue" appearing first
  in the results list for the query "Clay Av".

  the view uses some of the values from the 'search_defaults.js' file to add an
  additional 'SHOULD' condition which scores exact matches slighly higher
  than partial matches.
**/

module.exports = function( vs ){
  const view_name = 'boost_exact_matches';

  // get a copy of the *complete* tokens produced from the input:name
  const tokens = vs.var('input:name:tokens_complete').get();

  // no valid tokens to use, fail now, don't render this view.
  if( !tokens || tokens.length < 1 ){ return null; }

  // set 'input' to be only the fully completed characters
  vs.var(`match_phrase:${view_name}:input`).set( tokens.join(' ') );
  vs.var(`match_phrase:${view_name}:field`).set(searchDefaults['phrase:field']);

  vs.var(`match_phrase:${view_name}:analyzer`).set(searchDefaults['phrase:analyzer']);
  vs.var(`match_phrase:${view_name}:boost`).set(vs.var('phrase:boost').get());
  vs.var(`match_phrase:${view_name}:slop`).set(vs.var('phrase:slop').get());

  return peliasQuery.view.leaf.match_phrase(view_name)( vs );
};
