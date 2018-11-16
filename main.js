#!/usr/bin/env node

var DATAFILE = 'data.txt';

var JQUERY = ["http://code.jquery.com/jquery.js"];

//////////////////////////////////////////////////

var Http = require('http');
var Https = require('https');
var FS = require('fs');
var Path = require("path");
var JsDom = require("jsdom");
var Url = require('url');
var QueryString = require('querystring');
var ParseArgs = require('minimist');
var Uuid = require('node-uuid');
var Mime = require('mime');
var Sleep = require('sleep');

function isDir(dirPath) {
    try {
        return FS.statSync(dirPath).isDirectory();
    } catch (err) {
        if (err.code == 'ENOENT') { // no such file or directory. File really does not exist
          return false;
        }

        console.warn("EXCEPTION! fs.statSync (" + dirPath + "): " + err);
        throw e; // something else went wrong, we don't have rights, ...
    }
}

function fileExists(filePath) {
    try {
        return FS.statSync(filePath).isFile();
    } catch (err) {
        if (err.code == 'ENOENT') { // no such file or directory. File really does not exist
          return false;
        }

        console.warn("EXCEPTION! fs.statSync (" + filePath + "): " + err);
        throw e; // something else went wrong, we don't have rights, ...
    }
}

function fixUrl(url) {
    var urlObj = Url.parse(url);
    var queryObj = QueryString.parse(urlObj.query);
    if (queryObj) {
        var ignoreQueries = ARGV['ignore-query'] || "";
        ignoreQueries = ignoreQueries.split(",");
        ignoreQueries.forEach(function (q) {
            if (queryObj[q]) {
                delete queryObj[q];
            }
        });
    }
    urlObj.search = undefined;
    urlObj.query = queryObj;
    return Url.format(urlObj);
}

var WRITE_TIMER = null;
function writeDataFileLater(file, content) {
    if (WRITE_TIMER) {
        clearTimeout(WRITE_TIMER);
    }
    WRITE_TIMER = setTimeout(function () {
        FS.writeFileSync(file, content, "utf8");
        console.log("DATAFILE updated.");
    }, 1000);
}

var BlogSync = {};

BlogSync.download = function(url, dest, cb, headers) {
    try {
        if (isDir(dest)) {
            if (cb) cb(false, "EXCEPTION! Download destination is a directory: " + dest);
            return;
        }
        if (fileExists(dest)) {
            dest = Path.join(Path.dirname(dest), Path.basename(dest, Path.extname(dest)) + '.' + Uuid.v4() + Path.extname(dest));
        }
    } catch (e) {
        if (cb) cb(false, "EXCEPTION! File stat error: " + dest);
        return;
    }

    if (ARGV['update-data-only']) {
        if (cb) cb(true, dest + ' (skipped save)');
        return;
    }

    var urlObj = Url.parse(fixUrl(url));
    var options = {
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        path: urlObj.path,
        headers: headers || {}
    };
    if (urlObj.auth) {
        options['auth'] = urlObj.auth;
    }
    if (urlObj.port) {
        options['port'] = urlObj.port;
    }

    var file = FS.createWriteStream(dest);
    var httpKlazz = urlObj.protocol === 'https:' ? Https : Http;
    var request = httpKlazz.get(options, function(response) {
        response.pipe(file);
        file.on('finish', function() {
            file.close(function () {
                var touch = require("touch");
                var lastMod = response.headers['last-modified'] || Date.now();
                touch(dest, { mtime: new Date(lastMod) });
                if (!Path.extname(dest).match(/jpg|jpeg|gif|png|bmp|pdf/i)) {
                    var mime = response.headers['content-type'];
                    var ext = '.' + Mime.extension(mime);
                    if (ext !== Path.extname(dest)) {
                        var name = mime.split("/")[0] || Path.basename(dest, Path.extname(dest));
                        var newfn = Path.join(Path.dirname(dest), name + '.' + Uuid.v4() + ext);
                        FS.rename(dest, newfn);
                        dest = newfn;
                    }
                }

                cb(true, dest);
            }); // close() is async, call cb after close completes.
        });
    }).on('error', function(err) { // Handle errors
        FS.unlink(dest); // Delete the file async. (But we don't check the result)
        if (cb) cb(false, err.message);
    });
};

BlogSync.traverse = function (home, pattern, callback) {
    if (!pattern) {
        // if no home page pattern just start with this page as the first child page
        console.log("No home page pattern, start as first child page: ", home, "\n");
        callback(home);
    }

    var urlObj = Url.parse(home);
    var base = urlObj.protocol + (urlObj.slashes ? '//' : '') + urlObj.host;

    console.log("\tStart traverse: " + urlObj.href);
    JsDom.env(
        urlObj.href,
        JQUERY,
        {
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_6) AppleWebKit/601.7.7 (KHTML, like Gecko) Version/9.1.2 Safari/601.7.7'
        },
        function (err, window) {
            if (err) {
                console.error("EXCEPTION! Cannot load DOM for " + urlObj.href);
                return;
            }

            if (ARGV['no-redirect']) {
                var windowUrlObj = Url.parse("" + window.location.href);
                if (windowUrlObj.hostname !== urlObj.hostname || windowUrlObj.pathname !== urlObj.pathname) {
                    console.error("EXCEPTION! Redirection rejected. Given=" + urlObj.href + "; Actual=" + windowUrlObj.href);
                    return;
                }
            }

            var $ = window.$;
            // TODO: Error handling.
            if (pattern) {
                var matched = false;
                window.$(pattern).each(function (index) {
                    if (index > 0) {
                        // FIXME: Use BFS to traverse instead.
                        return;
                    }
                    var tagName = $(this).prop("tagName");
                    switch (tagName) {
                        case "A" :
                            matched = true;
                            var page = Url.resolve(base, $(this).attr("href"));
                            callback(page);
                            break;
                        default :
                            console.warn("EXCEPTION! Unknown element tag to save. Skipped: " + tagName);
                            break;
                    }
                });
                if (!matched) {
                    console.warn("No page pattern matched...", window.document.documentElement.outerHTML);
                }
            }
        }
    );
};

BlogSync.fetch = function (url, savePatterns, nextPattern, pagerUrl, titlePattern, willFetchCallback, saveCallback, savePageCallback, redoCount) {
    var urlObj = Url.parse(fixUrl(url));
    var base = urlObj.protocol + (urlObj.slashes ? '//' : '') + urlObj.host;

    if (willFetchCallback && !willFetchCallback(urlObj.href)) {
        console.log("\tSkipping fetch: " + urlObj.href);
        return;
    }

    if (ARGV['sleep'] && ~~ARGV['sleep'] > 0) {
        var sec = Math.ceil(Math.random() * ~~ARGV['sleep']);
        Sleep.sleep(sec);
    }

    JsDom.env(
        urlObj.href,
        JQUERY,
        {
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_6) AppleWebKit/601.7.7 (KHTML, like Gecko) Version/9.1.2 Safari/601.7.7'
        },
        function (err, window) {
            if (err) {
                console.error("EXCEPTION! Cannot load DOM for " + urlObj.href);
                return;
            }
            var $ = window.$;
            var cookies = require('cookies-js')(window);
            var headers = {
                Referer: urlObj.href
            };
            if (cookies.get('PHPSESSID')) { // FIXME: Hard coded to handle PHPSESSID...
                headers['Cookie'] = 'PHPSESSID='+cookies.get('PHPSESSID');
            }
            // TODO: Error handling.

            if (!window.$) {// BOGUS
                console.warn("BOGUS: ", urlObj.href);
                // redo...
                redoCount = ++redoCount || 1;
                if (redoCount > 3) {
                    console.warn("FAILED FETCH: ", urlObj.href);
                    return;
                }
                BlogSync.fetch(url, savePatterns, nextPattern, pagerUrl, titlePattern, function (page) {
                    console.warn("\tRE-FETCH: " + page);
                    return true;
                }, saveCallback, savePageCallback, redoCount);
                return;
            }

            var title = null;
            var savePageTitle = null;
            if (typeof titlePattern === 'string') {
                window.$(titlePattern).each(function (index) {
                    if (index > 0) {
                        return;
                    }
                    savePageTitle = $(this).text().trim();
                    savePageTitle = savePageTitle.split(/\s*\n+\s*/).join(' - ');
                    savePageTitle = savePageTitle.split(/\s+/).join(' ').trim();
                    if (!ARGV['folder-uses-pathname']) { // FIXME: Access to ARGV
                        title = savePageTitle;
                    }
                });
            } else if (titlePattern && titlePattern.title) {
                title = titlePattern.title; // inherit from upper call
                savePageTitle = titlePattern.title;
            }
            if (!title) {
                title = urlObj.pathname;
                title = title.charAt(0) === '/' ? title.slice(1) : title;
                title = Path.dirname(title) + '/' + Path.basename(title, Path.extname(title));
                title = title.replace(/\//g, '_');
            }
            if (!savePageTitle) {
                savePageTitle = title;
            }
            if (savePatterns) {
                savePatterns.split(",").forEach(function (pattern) {
                    window.$(pattern).each(function () {
                        var tagName = $(this).prop("tagName");
                        switch (tagName) {
                            case "A" :
                                var href = Url.resolve(base, $(this).attr("href"));
                                if (Path.extname(Url.parse(href).pathname).match(/(gif|jpg|jpeg|png|bmp|pdf)$/i)) {
                                    saveCallback(href, title, headers);
                                } else {
                                    BlogSync.fetch(href, savePatterns, null, null, { title: title }, null, saveCallback);
                                }
                                break;
                            case "IMG" :
                                var src = Url.resolve(base, $(this).attr("src"));
                                if (Path.extname(Url.parse(src).pathname).match(/(gif|jpg|jpeg|png|bmp|pdf|php)$/i)) {
                                    saveCallback(src, title, headers);
                                }
                                break;
                            default :
                                console.warn("Unknown element tag to save. Skipped: " + tagName);
                                break;
                        }
                    });
                });
            }
            if (nextPattern) {
                window.$(nextPattern).each(function (index) {
                    if (ARGV['next-filter-pattern']) {
                        var regexp = new RegExp(ARGV['next-filter-pattern'], "i");
                        var text = $(this).text();
                        if (!regexp.test(text)) {
                            return;
                        }
                    } else if (index > 0) {
                        // FIXME: Use BFS to traverse instead.
                        return;
                    }
                    var tagName = $(this).prop("tagName");
                    switch (tagName) {
                        case "A" :
                            var href = null;
                            if (pagerUrl) {
                                if (ARGV['pager-page-pattern']) {
                                    var html = $(this)[0].outerHTML;
                                    var regexp = new RegExp(ARGV['pager-page-pattern'], "i");
                                    var matches = html.match(regexp);
                                    if (matches) {
                                        href = pagerUrl.replace(/\{PAGE\}/gi, matches[1]); // XXX: assume [1]
                                    }
                                }
                                // TODO: otherwise?
                            } else {
                                // href = Url.resolve(base, $(this).attr("href"));

                                href = $(this).attr("href");
                                // handle "../xxx" in href
                                var matches = href.match(/^((\.\.\/)+)(.*?)\/?/);
                                if (matches) {
                                    href = urlObj.path + href;
                                }
                                href = Url.resolve(base, href);
                            }
                            BlogSync.fetch(href, savePatterns, nextPattern, pagerUrl, titlePattern, willFetchCallback, saveCallback, savePageCallback);
                            break;
                        default :
                            console.warn("Unknown element tag to go next. Skipped: " + tagName);
                            break;
                    }
                });
            }
            if (savePageCallback) {
                savePageCallback(savePageTitle, title, window.document.documentElement.outerHTML);
            }
        }
    );
};

//////////////////////////////////////////////////

var ARGV = ParseArgs(process.argv.slice(2), {
    string: ['home', 'out', 'page-pattern', 'next-pattern', 'pager-url', 'save-pattern', 'ignore-query', 'title-pattern', 'next-filter-pattern', 'pager-page-pattern', 'data-file', 'sleep'],
    boolean: [ 'stop-early', 'no-revisit', 'folderize', 'ignore-history', 'save-page', 'folder-uses-pathname', 'no-redirect', 'update-data-only' ]
});
console.dir(ARGV);

if (ARGV['data-file']) {
    DATAFILE = ARGV['data-file'];
    if (!fileExists(DATAFILE)) {
        require("touch").sync(DATAFILE);
    }
} else {
    require("touch").sync(DATAFILE);
}

// if (ARGV['folderize'] && !ARGV['title-pattern']) {
//     throw new Error('--folderize must come with --title-pattern');
// }

var tilde = require('tilde-expansion');
tilde(ARGV['out'], function(s) { ARGV['out'] = s; });
if (ARGV['out']) {
    var Mkdirp = require('mkdirp');
    Mkdirp.sync(ARGV['out']);
}

// TODO: Validate patterns.

//////////////////////////////////////////////////

var DATASTR = FS.readFileSync(DATAFILE, { encoding: 'utf8', flag: 'rs+' }).trim();
var DATA = DATASTR ? JSON.parse(DATASTR) : {};
if (ARGV['ignore-history']) {
    DATA = {};
}

if (Array.isArray(ARGV['home'])) {
    ARGV['home'] = ARGV['home'][ARGV['home'].length - 1];
}
var homeObj = Url.parse(ARGV['home'] || "");
if (!homeObj.href) {
    console.log("Invalid params, use help?");
    process.exit();
}
console.log("HOME: " + homeObj.href);

var title = Path.basename(ARGV['out'] || homeObj.pathname);
if (!DATA[title]) {
    DATA[title] = {};
}
var DATA_T = DATA[title];
if (!DATA_T['pages']) {
    DATA_T['pages'] = {};
}
var DATA_PAGES = DATA_T['pages'];
if (!DATA_T['saves']) {
    DATA_T['saves'] = {};
}
var DATA_SAVES = DATA_T['saves'];

//////////////////////////////////////////////////
///
/// MAIN
///
//////////////////////////////////////////////////

var stopEarly = false;
var homeTraversed = false;
// var cookieJar = JsDom.createCookieJar();   // TODO!

BlogSync.traverse(homeObj.href, ARGV['page-pattern'], function (page) {

    if (DATA_PAGES[homeObj.href] && homeTraversed) {
        // prevent next links loop back to home
        return;
    } else {
        homeTraversed = true;
        DATA_PAGES[homeObj.href] = true;
    }

    BlogSync.fetch(
        page,
        ARGV['save-pattern'],
        ARGV['next-pattern'],
        ARGV['pager-url'],
        ARGV['title-pattern'],
        function (page) {
            if (ARGV['stop-early'] && stopEarly) {
                return false;
            }
            if ((ARGV['no-revisit'] || ARGV['stop-early']) && DATA_PAGES[page]) {
                stopEarly = true;
                return false;
            } else {
                DATA_PAGES[page] = true;
                console.log("\tFETCH: " + page);
                return true;
            }
        },
        function (url, title, headers) {
            if (DATA_SAVES[url]) {
                return;
            }

            var urlObj = Url.parse(fixUrl(url));
            var savePath = ARGV['out'];
            if (ARGV['folderize'] && title) {
                var sanitize = require("sanitize-filename");
                title = title.replace(/\n/g, ' - ');
                var folder = sanitize(title).substring(0,40);
                savePath = Path.resolve(ARGV['out'], folder);
            }
            var Mkdirp = require('mkdirp');
            Mkdirp.sync(savePath);
            var fn = Path.basename(urlObj.pathname);
            if (!fn) { return; } // bailout for potential url to an empty path (home page)
            savePath = Path.resolve(savePath, fn);

            BlogSync.download(urlObj.href, savePath, function (success, arg1) {
                if (success) {
                    console.log("\t\tSAVED: " + urlObj.href + " to '" + arg1 + "'");
                    DATA_SAVES[url] = true;
                    if (!ARGV['ignore-history']) {
                        writeDataFileLater(DATAFILE, JSON.stringify(DATA));
                    }
                } else {
                    console.log("\t\tSAVE FAILED: " + urlObj.href, arg1);
                }
            }, headers);
        },
        (ARGV['save-page'] ? function (title, folder, content) {
            var savePath = ARGV['out'];
            var sanitize = require("sanitize-filename");
            folder = folder.replace(/\n/g, ' - ');
            folder = sanitize(folder);
            if (ARGV['folderize'] && folder) {
                savePath = Path.resolve(ARGV['out'], folder);
            }
            var Mkdirp = require('mkdirp');
            Mkdirp.sync(savePath);
            savePath = Path.resolve(savePath, sanitize(title).substring(0,40) + ".html");

            if (ARGV['update-data-only']) {
                console.log("\t\tPAGE SAVE SKIPPED: " + savePath);
                if (!ARGV['ignore-history']) {
                    writeDataFileLater(DATAFILE, JSON.stringify(DATA));
                }
                return;
            }

            try {
                if (fileExists(savePath)) {
                    savePath = Path.join(Path.dirname(savePath), Path.basename(savePath, Path.extname(savePath)) + '.' + Uuid.v4() + Path.extname(savePath));
                }
                FS.writeFile(savePath, content, function (err) {
                    if (err) throw err;
                    console.log("\t\tPAGE SAVED: " + savePath);
                    if (!ARGV['ignore-history']) {
                        writeDataFileLater(DATAFILE, JSON.stringify(DATA));
                    }
                });
            } catch (e) {
                return;
            }
        } : null)
    );
});
