// Scanner probes: requests for paths that only attack tools ask for (GraphQL endpoints, WordPress, phpMyAdmin, .env, .git, *.php ...). This app has none of
// them, so nobody legitimate ever sends one. They are answered with a plain 404 straight away (no session, no database), written to the audit log, and
// an address that tries several different ones is blocked for 24 hours (Administration > IP Access shows it; remove it there if it was a mistake).
// Switch the automatic block off with AUTO_BLOCK_PROBES=false (probes are then only logged and counted).
const PROBE = new RegExp([
  '\\.(php\\d?|phtml|asp|aspx|jsp|jspx|cgi|cfm|env|bak|sql|swp|git|svn|htaccess|htpasswd)(/|\\?|$)',
  '(^|/)\\.(env|git|svn|hg|aws|ssh|docker|npmrc|DS_Store)',
  '(^|/)(wp-(login|admin|content|includes|json|config)|xmlrpc|phpmyadmin|pma|adminer|cgi-bin|boaform|HNAP1|actuator|server-status|server-info|vendor/phpunit|manager/html|jmx-console|solr|jenkins|owa|ecp|autodiscover|remote/login|sdk|evox|nmaplowercheck)(/|\\?|$)',
  '^/api/?$|^/api/(gql|graphql|graphiql|swagger|swagger-ui|api-docs|openapi|v[0-9]+(/|$)|rest(/|$)|debug|console|actuator)',
  '^/(gql|graphql|graphiql|swagger|swagger-ui|api-docs|openapi\\.json|debug|console)(/|\\?|$)',
].join('|'), 'i');

const isProbe = (urlPath) => PROBE.test(String(urlPath || '').split('?')[0]);

function middleware(req, res, next) {
  if (!isProbe(req.path)) return next();
  require('./security-watch').probe(req);
  res.status(404).set('Cache-Control', 'no-store').type('text/plain').send('Not found');
}

module.exports = { middleware, isProbe, PROBE };
