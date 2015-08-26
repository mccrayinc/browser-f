/* -*- js-indent-level: 2; indent-tabs-mode: nil -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

this.EXPORTED_SYMBOLS = ["TelemetryFile"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

Cu.import("resource://gre/modules/Services.jsm", this);
Cu.import("resource://gre/modules/XPCOMUtils.jsm", this);
Cu.import("resource://gre/modules/osfile.jsm", this);
Cu.import("resource://gre/modules/Task.jsm", this);
Cu.import("resource://gre/modules/Promise.jsm", this);

XPCOMUtils.defineLazyModuleGetter(this, 'Deprecated',
  'resource://gre/modules/Deprecated.jsm');

const Telemetry = Services.telemetry;

// Files that have been lying around for longer than MAX_PING_FILE_AGE are
// deleted without being loaded.
const MAX_PING_FILE_AGE = 14 * 24 * 60 * 60 * 1000; // 2 weeks

// Files that are older than OVERDUE_PING_FILE_AGE, but younger than
// MAX_PING_FILE_AGE indicate that we need to send all of our pings ASAP.
const OVERDUE_PING_FILE_AGE = 7 * 24 * 60 * 60 * 1000; // 1 week

// Maximum number of pings to save.
const MAX_LRU_PINGS = 17;

// The number of outstanding saved pings that we have issued loading
// requests for.
let pingsLoaded = 0;

// The number of pings that we have destroyed due to being older
// than MAX_PING_FILE_AGE.
let pingsDiscarded = 0;

// The number of pings that are older than OVERDUE_PING_FILE_AGE
// but younger than MAX_PING_FILE_AGE.
let pingsOverdue = 0;

// Data that has neither been saved nor sent by ping
let pendingPings = [];

let isPingDirectoryCreated = false;

this.TelemetryFile = {

  get MAX_PING_FILE_AGE() {
    return MAX_PING_FILE_AGE;
  },

  get OVERDUE_PING_FILE_AGE() {
    return OVERDUE_PING_FILE_AGE;
  },

  get MAX_LRU_PINGS() {
    return MAX_LRU_PINGS;
  },

  get pingDirectoryPath() {
    return OS.Path.join(OS.Constants.Path.profileDir, "saved-telemetry-pings");
  },

  /**
   * Save a single ping to a file.
   *
   * @param {object} ping The content of the ping to save.
   * @param {string} file The destination file.
   * @param {bool} overwrite If |true|, the file will be overwritten if it exists,
   * if |false| the file will not be overwritten and no error will be reported if
   * the file exists.
   * @returns {promise}
   */
  savePingToFile: function(ping, file, overwrite) {
    return Task.spawn(function*() {
      try {
        let pingString = JSON.stringify(ping);
        yield OS.File.writeAtomic(file, pingString, {tmpPath: file + ".tmp",
                                  noOverwrite: !overwrite});
      } catch(e if e.becauseExists) {
      }
    })
  },

  /**
   * Save a ping to its file.
   *
   * @param {object} ping The content of the ping to save.
   * @param {bool} overwrite If |true|, the file will be overwritten
   * if it exists.
   * @returns {promise}
   */
  savePing: function(ping, overwrite) {
    return Task.spawn(function*() {
      yield getPingDirectory();
      let file = pingFilePath(ping);
      yield this.savePingToFile(ping, file, overwrite);
    }.bind(this));
  },

  /**
   * Save all pending pings.
   *
   * @param {object} sessionPing The additional session ping.
   * @returns {promise}
   */
  savePendingPings: function(sessionPing) {
    let p = pendingPings.reduce((p, ping) => {
      // Restore the files with the previous pings if for some reason they have
      // been deleted, don't overwrite them otherwise.
      p.push(this.savePing(ping, false));
      return p;}, [this.savePing(sessionPing, true)]);

    pendingPings = [];
    return Promise.all(p);
  },

  /**
   * Add a ping from an existing file to the saved pings directory so that it gets saved
   * and sent along with other pings.
   * Note: that the original ping file will not be modified.
   *
   * @param {String} aFilePath The path to the ping file that needs to be added to the
   *                           saved pings directory.
   * @return {Promise} A promise resolved when the ping is saved to the pings directory.
   */
  addPendingPingFromFile: function(aPingPath) {
    // Pings in the saved ping directory need to have the ping id or slug (old format) as
    // the file name. We load the ping content, check that it is valid, and use it to save
    // the ping file with the correct file name.
    return loadPingFile(aPingPath).then(ping => {
        // Since we read a ping successfully, update the related histogram.
        Telemetry.getHistogramById("READ_SAVED_PING_SUCCESS").add(1);
        this.addPendingPing(ping);
      });
  },

  /**
   * Add a ping to the saved pings directory so that it gets saved
   * and sent along with other pings.
   * Note: that the original ping file will not be modified.
   *
   * @param {Object} ping The ping object.
   * @return {Promise} A promise resolved when the ping is saved to the pings directory.
   */
  addPendingPing: function(ping) {
    // Append the ping to the pending list.
    pendingPings.push(ping);
    // Save the ping to the saved pings directory.
    return this.savePing(ping, false);
  },

  /**
   * Remove the file for a ping
   *
   * @param {object} ping The ping.
   * @returns {promise}
   */
  cleanupPingFile: function(ping) {
    return OS.File.remove(pingFilePath(ping));
  },

  /**
   * Load all saved pings.
   *
   * Once loaded, the saved pings can be accessed (destructively only)
   * through |popPendingPings|.
   *
   * @returns {promise}
   */
  loadSavedPings: function() {
    return Task.spawn(function*() {
      let directory = TelemetryFile.pingDirectoryPath;
      let iter = new OS.File.DirectoryIterator(directory);
      let exists = yield iter.exists();

      if (exists) {
        let entries = yield iter.nextBatch();
        let sortedEntries = [];

        for (let entry of entries) {
          if (entry.isDir) {
            continue;
          }

          let info = yield OS.File.stat(entry.path);
          sortedEntries.push({entry:entry, lastModificationDate: info.lastModificationDate});
        }

        sortedEntries.sort(function compare(a, b) {
          return b.lastModificationDate - a.lastModificationDate;
        });

        let count = 0;
        let result = [];

        // Keep only the last MAX_LRU_PINGS entries to avoid that the backlog overgrows.
        for (let i = 0; i < MAX_LRU_PINGS && i < sortedEntries.length; i++) {
          let entry = sortedEntries[i].entry;
          result.push(this.loadHistograms(entry.path))
        }

        for (let i = MAX_LRU_PINGS; i < sortedEntries.length; i++) {
          let entry = sortedEntries[i].entry;
          OS.File.remove(entry.path);
        }

        yield Promise.all(result);

        Services.telemetry.getHistogramById('TELEMETRY_FILES_EVICTED').
          add(sortedEntries.length - MAX_LRU_PINGS);
      }

      yield iter.close();
    }.bind(this));
  },

  /**
   * Load the histograms from a file.
   *
   * Once loaded, the saved pings can be accessed (destructively only)
   * through |popPendingPings|.
   *
   * @param {string} file The file to load.
   * @returns {promise}
   */
  loadHistograms: function loadHistograms(file) {
    return OS.File.stat(file).then(function(info){
      let now = Date.now();
      if (now - info.lastModificationDate > MAX_PING_FILE_AGE) {
        // We haven't had much luck in sending this file; delete it.
        pingsDiscarded++;
        return OS.File.remove(file);
      }

      // This file is a bit stale, and overdue for sending.
      if (now - info.lastModificationDate > OVERDUE_PING_FILE_AGE) {
        pingsOverdue++;
      }

      pingsLoaded++;
      return addToPendingPings(file);
    });
  },

  /**
   * The number of pings loaded since the beginning of time.
   */
  get pingsLoaded() {
    return pingsLoaded;
  },

  /**
   * The number of pings loaded that are older than OVERDUE_PING_FILE_AGE
   * but younger than MAX_PING_FILE_AGE.
   */
  get pingsOverdue() {
    return pingsOverdue;
  },

  /**
   * The number of pings that we just tossed out for being older than
   * MAX_PING_FILE_AGE.
   */
  get pingsDiscarded() {
    return pingsDiscarded;
  },

  /**
   * Iterate destructively through the pending pings.
   *
   * @return {iterator}
   */
  popPendingPings: function*() {
    while (pendingPings.length > 0) {
      let data = pendingPings.pop();
      yield data;
    }
  },

  testLoadHistograms: function(file) {
    pingsLoaded = 0;
    return this.loadHistograms(file.path);
  }
};

///// Utility functions
function pingFilePath(ping) {
  // Support legacy ping formats, who don't have an "id" field, but a "slug" field.
  let pingIdentifier = (ping.slug) ? ping.slug : ping.id;
  return OS.Path.join(TelemetryFile.pingDirectoryPath, pingIdentifier);
}

function getPingDirectory() {
  return Task.spawn(function*() {
    let directory = TelemetryFile.pingDirectoryPath;

    if (!isPingDirectoryCreated) {
      yield OS.File.makeDir(directory, { unixMode: OS.Constants.S_IRWXU });
      isPingDirectoryCreated = true;
    }

    return directory;
  });
}

/**
 * Loads a ping file.
 * @param {String} aFilePath The path of the ping file.
 * @return {Promise<Object>} A promise resolved with the ping content or rejected if the
 *                           ping contains invalid data.
 */
let loadPingFile = Task.async(function* (aFilePath) {
  let array = yield OS.File.read(aFilePath);
  let decoder = new TextDecoder();
  let string = decoder.decode(array);

  let ping = JSON.parse(string);
  // The ping's payload used to be stringified JSON.  Deal with that.
  if (typeof(ping.payload) == "string") {
    ping.payload = JSON.parse(ping.payload);
  }
  return ping;
});

function addToPendingPings(file) {
  function onLoad(success) {
    let success_histogram = Telemetry.getHistogramById("READ_SAVED_PING_SUCCESS");
    success_histogram.add(success);
  }

  return loadPingFile(file).then(ping => {
      pendingPings.push(ping);
      onLoad(true);
    },
    () => {
      onLoad(false);
      return OS.File.remove(file);
    });
}