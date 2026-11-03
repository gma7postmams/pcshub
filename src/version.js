// Bump SCHEMA_VERSION whenever schema.sql / migrate.js change the database shape; backups record it.
module.exports = {
  SCHEMA_VERSION: 3,
  APP_VERSION: require('../package.json').version,
};
