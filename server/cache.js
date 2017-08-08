'use strict'

const fs = require('fs')

const request = require('request')
const async = require('async')

const cache = {} // simple path to html cache
const byId = {} // id to last modified + paths
const noCache = {} // paths not to cache, mapped to timeouts of when they can be cached again
let instances = [] // the IPs of all the other library instances
let kubeToken = null // store the kube token here after we read it
startInstancePolling()

exports.middleware = (req, res, next) => {
  const cachedHTML = cache[req.path]

  const {purge, edit, recurse} = req.query
  if (purge || edit) {
    return purgeCache(req.path, edit, recurse, (err) => {
      if (err) {
        // if we failed, we should probably update the instance list
        if (kubeToken) updateInstances(kubeToken)
        return res.status(500).send(err)
      }

      console.log('Distributed cache purged successfully.')
      res.end('OK')
    })
  } // deletes cache for a particular route

  if (cachedHTML) {
    console.log(`Serving cached response to ${req.path}.`)
    return res.end(cachedHTML)
  }

  next()
}

exports.add = (id, modified, path, html) => {
  if (!modified) return // refused to add anything without a modified timestamp

  if (noCache[path]) return // refuse to cache any items that are being edited

  cache[path] = html
  const data = byId[id] || {paths: new Set(), modified}
  data.paths.add(path)

  byId[id] = data
}

// purge assets by id and their modified times
exports.purge = (id, newModified) => {
  const data = byId[id]
  if (!data) return
  // skip purging items which have not changed
  if (data.modified === newModified) return

  data.paths.forEach((path) => {
    const segments = path.split('/').map((segment, i, segments) => {
      return segments.slice(0, i).concat([segment]).join('/')
    })

    // don't just purge the top path, purge all the parents too.
    // no recursion here since other instances will determine themselves when pages have expired
    segments.forEach((url) => {
      if (!cache[url]) return
      console.log(`Purching cache of ${url}`)
      purgeCache(url)
    })
  })
}

function startInstancePolling() {
  try {
    kubeToken = fs.readFileSync('***REMOVED***', 'utf8')
  } catch (e) {
    return console.log('No token file so will not produce an instance list.')
  }

  const poll = () => {
    updateInstances(kubeToken, (err, ips) => {
      if (err) {
        console.log('Got error while attempting to update instance IPs:', err)
      }
      console.log('Instance IP list updated.', ips)

      // after some delay, update again.
      setTimeout(poll, 1 * 60 * 1000) // 1 min
    })
  }

  poll()
}

function updateInstances(token, cb = () => {}) {
  request.get({
    url: '***REMOVED***',
    rejectUnauthorized: false,
    qs: {
      labelSelector: 'app=nyt-library'
    },
    auth: {
      bearer: token
    },
    json: true
  }, (err, res, body) => {
    if (err) {
      return cb(err)
    }

    if (res.statusCode !== 200) {
      return cb(Error(`Got status ${res.statusCode}; expected 200 while updating instance list.`))
    }

    // pull off all the pod IPs
    instances = body.items.map((i) => i.status.podIP)
    cb(null, instances)
  })
}

function purgeCache(path, preventCache, recurse, cb) {
  if (recurse) {
    // rather than try to delete our cache directly, purge all instances
    // we don't know what IP we are on
    return async.each(instances, (instance, cb) => {
      const qs = {
        purge: 1
      }

      // if we are setting a timeout, pass that along with the request
      if (preventCache) qs.edit = 1

      const url = `http://${instance}:3000${path}`
      request.get({
        url,
        qs
      }, (err, res, body) => {
        if (err) return cb(err)

        if (res.statusCode !== 200) {
          return cb(Error(`Tried to purge ${url} but received ${res.statusCode}; expected 200.`))
        }

        console.log(`Purged cache @ ${url}`)
        cb(null, body)
      })
    }, cb)
  }

  if (preventCache) {
    console.log(`Preventing cache of ${path} for next hour.`)
    const existingTimer = noCache[path]
    if (existingTimer) clearTimeout(existingTimer)
    noCache[path] = setTimeout(() => delete noCache[path], 60 * 60 * 1000) // 1 hr
  }

  // if this is specifically to just purge on this node, don't make requests elsewhere
  console.log(`Purging cache of ${path}.`)
  delete cache[path]
  if (cb) cb(null)
}
