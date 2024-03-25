/**
 * Production environment settings
 *
 * This file can include shared settings for a production environment,
 * such as API keys or remote database passwords.  If you're using
 * a version control solution for your Sails app, this file will
 * be committed to your repository unless you add it to your .gitignore
 * file.  If your repository will be publicly viewable, don't add
 * any private information to this file!
 *
 */

module.exports = {

  /***************************************************************************
   * Set the default database connection for models in the production        *
   * environment (see config/datastores.js and config/models.js )            *
   ***************************************************************************/
  appUrl: "https://update.minz.lol",
  sockets: {
    onlyAllowOrigins: ["http://47.128.229.3:8080", "http://localhost", "https://update.minz.lol", "https://test.update.minz.lol"]
  },
  auth: {
    // Provide a set of credentials that can be used to access the admin interface.
    static: {
      username: 'test',
      password: 'test'
    },
  },
  jwt: {
    token_secret: 'WPE$oVW_viBbPeegv[:X}/jMvN7d)~WDD(oOqh{gjI?Mkk/LAJAgiWO9OZGKo7S'
  },
  models: {
    datastore: 'postgresql',
    migrate: 'alter'
  },

  datastores: {
    postgresql: {
      adapter: 'sails-postgresql',
      host: 'localhost',//'database-test-1.c7cskwcqmuzf.ap-southeast-1.rds.amazonaws.com',
      user: 'release_admin',
      password: 'postgres',
      database: 'releaseserver'
    }
  },
  /***************************************************************************
   * Set the port in the production environment to 80                        *
   ***************************************************************************/

  port: 8080,

  /***************************************************************************
   * Set the log level in production environment to "silent"                 *
   ***************************************************************************/

  log: {
    level: "silent"
  },

  auth: {
    static: {
      username: 'test',
      password: 'test'
    },
    secret: process.env.TOKEN_SECRET
  }

};
