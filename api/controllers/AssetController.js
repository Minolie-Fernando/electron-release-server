/**
 *  AssetController
 *
 * @description :: Server-side logic for managing assets
 * @help        :: See http://sailsjs.org/#!/documentation/concepts/Controllers
 */

var _ = require('lodash');
var path = require('path');
var actionUtil = require('sails/lib/hooks/blueprints/actionUtil');
var Promise = require('bluebird');

module.exports = {

  /**
   * Download a release artifact
   *
   * Note: if a filename is specified, nothing but the filetype is used.
   * This is because Squirrel.Windows does a poor job of parsing the filename,
   * and so we must fake the filenames of x32 and x64 versions to be the same.
   *
   * (GET /download/latest/:platform?': 'AssetController.download')
   * (GET /download/:version/:platform?/:filename?': 'AssetController.download')
   * (GET /download/channel/:channel/:platform?': 'AssetController.download')
   * (GET /download/flavor/:flavor/latest/:platform?': 'AssetController.download')
   * (GET /download/flavor/:flavor/:version/:platform?/:filename?': 'AssetController.download')
   * (GET /download/flavor/:flavor/channel/:channel/:platform?': 'AssetController.download')
   */
  download: function(req, res) {
    var channel = req.params.channel;
    var version = req.params.version || undefined;
    var filename = req.params.filename;
    var filetype = req.query.filetype;
    const flavor = req.params.flavor || 'default';

    // We accept multiple platforms (x64 implies x32)
    var platforms;
    var platform = req.param('platform');
    if (platform) {
      platforms = [platform];
    }

    // Normalize filetype by prepending with period
    if (_.isString(filetype) && filetype[0] !== '.') {
      filetype = '.' + filetype;
    } else if (filename) {
      filetype = filename.substr(filename.lastIndexOf('.'));
    }

    // Detect platform from useragent
    if (!platforms) {
      platforms = PlatformService.detectFromRequest(req);

      if (!platforms) {
        return res.serverError(
          'No platform specified and detecting one was unsuccessful.'
        );
      }
    } else {
      platforms = PlatformService.sanitize(platforms);
    }

    if (!version) {
      channel = channel || 'stable';
    }

    new Promise(function(resolve, reject) {
        var assetOptions = UtilityService.getTruthyObject({
          platform: platforms,
          filetype: filetype
        });

        sails.log.debug('Asset requested with options', assetOptions);

        sails.log.debug('Asset version --> ', version);
        sails.log.debug('Asset channel', channel);
        if (version || channel) {
          Version
            .find(UtilityService.getTruthyObject({
              name: version,
              channel: channel,
              flavor
            }))
            .sort([{
              createdAt: 'desc'
            }])
            // the latest version maybe has no assets, for example
            // the moment between creating a version and uploading assets,
            // so find more than 1 version and use the one containing assets.
            .limit(10)
            .populate('assets', assetOptions)
            .then(function(versions) {

              sails.log.debug('Asset versions', versions);
              if (!versions || !versions.length) {
                return resolve();
              }

              // sort versions by `name` instead of `createdAt`,
              // an lower version could be deleted then be created again,
              // thus it has newer `createdAt`.
              versions = versions.sort(UtilityService.compareVersion);
              var version;
              for (var i = 0; i < versions.length; i++) {
                version = versions[i];
                if (version.assets && version.assets.length) {
                  break;
                }
              }

              if (!version.assets || !version.assets.length) {
                return resolve();
              }

              // Sorting filename in ascending order prioritizes other files
              // over zip archives is both are available and matched.
              return resolve(_.orderBy(
                version.assets, ['filetype', 'createdAt'], ['asc', 'desc']
              )[0]);
            })
            .catch(reject);
        } else {
          Asset
            .find(assetOptions)
            .sort([{
              createdAt: 'desc'
            }])
            .limit(1)
            .then(resolve)
            .catch(reject);
        }
      })
      .then(function(asset) {

        sails.log.debug('Asset asset', asset);
        
        if (!asset || !asset.fd) {
          let noneFoundMessage = `The ${flavor} flavor has no download available`;

          if (platforms) {
            if (platforms.length > 1) {
              noneFoundMessage += ' for platforms ' + platforms.toString();
            } else {
              noneFoundMessage += ' for platform ' + platforms[0];
            }
          }

          noneFoundMessage += version ? ' for version ' + version : '';
          noneFoundMessage += channel ? ' (' + channel + ') ' : '';
          noneFoundMessage += filename ? ' with filename ' + filename : '';
          noneFoundMessage += filetype ? ' with filetype ' + filetype : '';
          return res.notFound(noneFoundMessage);
        }

        // Serve asset & log analytics
        return AssetService.serveFile(req, res, asset);
      })
      // Catch any unhandled errors
      .catch(res.negotiate);
  },

  create: function(req, res) {
    // Create data object (monolithic combination of all parameters)
    // Omit the blacklisted params (like JSONP callback param, etc.)
    var data = actionUtil.parseValues(req);

    if (!data.version) {
      return res.badRequest('A version is required.');
    }

    if (_.isString(data.version)) {
      // Only a id was provided, normalize
      data.version = {
        id: data.version
      };
    } else if (data.version && data.version.id) {
      // Valid request, but we only want the id
      data.version = {
        id: data.version.id
      };
    } else {
      return res.badRequest('Invalid version provided.');
    }

    // Check that the version exists (or its `_default` flavor equivalent)
    Version
      .find({
        id: [data.version.id, `${data.version.id}_default`]
      })
      .then(versions => {
        if (!versions || !versions.length) {
          return res.notFound('The specified `version` does not exist');
        }

        data.version.id = versions[versions.length - 1].id;

        // Set upload request timeout to 10 minutes
        req.setTimeout(10 * 60 * 1000);

        req.file('file').upload(sails.config.files,
          function whenDone(err, uploadedFiles) {
            if (err) {
              return res.negotiate(err);
            }

            // If an unexpected number of files were uploaded, respond with an
            // error.
            if (uploadedFiles.length !== 1) {
              return res.badRequest('No file was uploaded');
            }

          sails.log.debug(' 1 uploadedFiles', uploadedFiles);

            var uploadedFile = uploadedFiles[0];

            sails.log.debug(' 2uploadedFile', uploadedFile);

            if (uploadedFile.filename === 'RELEASES') {
              return res.badRequest(
                'The RELEASES file should not be uploaded since the release server will generate at request time');
            }

            var fileExt = path.extname(uploadedFile.filename);

            sails.log.debug('Creating asset with name', data.name || uploadedFile.filename);

            
            var hashPromise;

            if (fileExt === '.nupkg') {
              // Calculate the hash of the file, as it is necessary for windows
              // files
              hashPromise = AssetService.getHash(uploadedFile.fd);
            } else if (fileExt === '.exe' || fileExt === '.zip') {
              hashPromise = AssetService.getHash(
                uploadedFile.fd,
                "sha512",
                "base64"
              );
            } else {
              hashPromise = Promise.resolve('');
            }

            hashPromise
              .then(function(fileHash) {
                var newAsset = _.merge({
                  name: uploadedFile.filename,
                  hash: fileHash,
                  filetype: fileExt,
                  fd: uploadedFile.fd,
                  size: uploadedFile.size
                }, data);

                // Due to an API change in Sails/Waterline, the primary key values must be specified directly.=
                newAsset.version = newAsset.version.id;

                const delta = newAsset.name && newAsset.name.toLowerCase().includes('-delta') ? 'delta_' : '';
                newAsset.id = `${newAsset.version}_${newAsset.platform}_${delta}${newAsset.filetype.replace(/\./g, '')}`;

                // Create new instance of model using data from params
                Asset
                  .create(newAsset)
                  .exec(function created(err, newInstance) {

                    // Differentiate between waterline-originated validation errors
                    // and serious underlying issues. Respond with badRequest if a
                    // validation error is encountered, w/ validation info.
                    if (err) return res.negotiate(err);

                    // If we have the pubsub hook, use the model class's publish
                    // method to notify all subscribers about the created item.
                    if (req._sails.hooks.pubsub) {
                      if (req.isSocket) {
                        Asset.subscribe(req, newInstance);
                        Asset.introduce(newInstance);
                      }
                      Asset.publish([newInstance.id], {
                        verb: 'created',
                        id: newInstance.id,
                        data: newInstance
                      }, !req.options.mirror && req);
                    }

                    // Send JSONP-friendly response if it's supported
                    res.ok(newInstance);
                  });
              })
              .catch(res.negotiate);
          });
      });
  },

  destroy: function(req, res) {
    var pk = actionUtil.requirePk(req);

    var query = Asset.findOne(pk);
    query.populate('version');
    query
      .then(function foundRecord(record) {
        if (!record) return res.notFound(
          'No record found with the specified `name`.'
        );

        // Delete the file & remove from db
        return Promise.join(
            AssetService.destroy(record, req),
            AssetService.deleteFile(record),
            function() {})
          .then(function success() {
            res.ok(record);
          });
      })
      .error(res.negotiate);
  },

  health: function(req, res) {
    res.status(200).send('FFLSafe Update Center Health Check Validation!');
  },

  latestVersion: function(req, res) {
    let channel = req.params.channel;
    let version = req.params.version || undefined;
    const filename = req.params.filename;
    let filetype = req.query.filetype;
    const flavor = req.params.flavor || 'default';
  
    sails.log.debug('Request for latest version with channel:', channel);
  
    let platforms;
    let platform = req.param('platform');
    if (platform) {
      platforms = [platform];
    }
  
    sails.log.debug('Platform from request:', platform);
  
    // Normalize filetype
    filetype = filetype && filetype[0] !== '.' ? '.' + filetype : filename ? filename.substring(filename.lastIndexOf('.')) : undefined;
  
    // Determine platforms based on request
    if (!platforms) {
      platforms = PlatformService.detectFromRequest(req);
      if (!platforms) {
        sails.log.error('Failed to detect platform from request.');
        return res.serverError('Failed to detect platform.');
      }
      platforms = PlatformService.sanitize(platforms);
    }
  
    const assetOptions = UtilityService.getTruthyObject({ platform: platforms, filetype });
  
    if (!version) {
      channel = channel || 'stable';
    }
  
    if (version || channel) {
      Version.find(UtilityService.getTruthyObject({ name: version, channel, flavor }))
        .sort([{ createdAt: 'desc' }])
        .limit(10)
        .populate('assets', assetOptions)
        .then(versions => {
          sails.log.debug('Found versions:', versions);
  
          // versions.sort(UtilityService.compareVersion);
          // for (let i = 0; i < versions.length; i++) {
          //   if (versions[i].assets && versions[i].assets.length) {
          //     return res.ok(versions[i].name);
          //   }
          // }
  
          // sails.log.debug('No versions with assets found.');
          return res.ok( {
            "version" : versions[0].name 
          });
          // return res.notFound('No available versions with assets.');
        })
        .catch(error => {
          sails.log.error('Error retrieving versions:', error);
          return res.serverError('Error retrieving versions.');
        });
    } else {
      Asset.find(assetOptions)
        .sort([{ createdAt: 'desc' }])
        .limit(1)
        .then(assets => {
          if (assets.length > 0) {
            return res.ok(assets[0].version);
          } else {
            return res.notFound('No assets found.');
          }
        })
        .catch(error => {
          sails.log.error('Error retrieving assets:', error);
          return res.serverError('Error retrieving assets.');
        });
    }
  }
  
};
