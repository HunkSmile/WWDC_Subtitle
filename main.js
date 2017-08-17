/**
 * Created by qiaoxueshi on 6/20/15.
 */

var async = require('async');
var request = require('request');
var fx = require('fs-extra');
var fs = require('fs');
var cheerio = require('cheerio');
var argv = require('minimist')(process.argv.slice(2));
var sutil = require('./subtitle_util');

var videoLinksFile = "WWDC2015_links.txt";
var lang = argv.lang ? argv.lang : 'zho';
var subtitlesFolderForHD = "subtitles/HD/"+lang+"/";
var subtitlesFolderForSD = "subtitles/SD/"+lang+"/";

var videoURLRegex = /(http:\/\/devstreaming.apple.com\/videos\/wwdc\/\d+\/\w+\/\d+\/)(\w+)\.mp4\?dl=1/;
async.waterfall([
    //read links file
    function(callback) {
        if (argv.mp4) {
            // exp: node main.js --mp4 http://devstreaming.apple.com/videos/wwdc/2015/713gc2tqvvb/713/713_hd_introducing_watch_connectivity.mp4?dl=1
            console.log('======== Mp4:'+argv.mp4+' ======== ');
            var links = [argv.mp4];
            callback(null, links);
        } else if (argv.page) {
            // exp: node main.js --page https://developer.apple.com/videos/play/wwdc2016/228/
            console.log('======== Page:'+argv.page+' ======== ');
            callback(null, {title: '', link: argv.page, isSectionLink: true});
        } else if (argv.year) {
            // exp: node main.js --year 2016
            console.log('======== Year:'+argv.year+' ======== ');
            callback(null, argv.year);
        } else {
            fs.readFile(videoLinksFile, 'utf-8', function (err, data) {
                if (err) throw err;
                var lines = data.split("\n");
                var links = lines.filter(function (line) {
                    return line && line.length > 0 && line.indexOf('.mp4') !== -1;;
                });
                callback(null, links);
            });
        }
    },

    // get full year list of video page url
    function (year, callback) {
        if (typeof year !== 'string' && typeof year !== 'number') return callback(null, year);
        url = 'https://developer.apple.com/videos/wwdc'+year+'/';
        var options = {
          url: url,
          headers: {
            'User-Agent': 'request'
          }
        };
        request(options, function (err, response, body) {
            if (!err && response.statusCode === 200) {
                var $ = cheerio.load(body);
                console.log($('title').text());
                var allGroups = $('ul.collection-focus-groups li.collection-focus-group');
                allGroups.each(function (i, group) {
                    var groupTitle = $('section.sticky', group).text().trim();
                    var sections = $('ul.collection-items li.collection-item', group);
                    console.log(groupTitle + ': x' + sections.length);
                    sections.each(function (i, section) {
                        var sectionTitle = $('h5', section).text();
                        var link = 'https://developer.apple.com'+$('a', section).attr('href');
                        console.log('---- '+sectionTitle);
                        callback(null, {title: sectionTitle, link: link, isSectionLink:true});
                    });
                });
            } else {
                callback(err, response);
            }
        });
    },

    // get hd-video link , sd-video link and pdf document link from a video page
    function (pageInfo, callback) {
        if (!pageInfo.isSectionLink) return callback(null, pageInfo);
        var options = {
          url: pageInfo.link,
          headers: {
            'User-Agent': 'request'
          }
        };
        request(options, function (err, response, body) {
            if (!err && response.statusCode === 200) {
                var $ = cheerio.load(body);
                var videoLinks = $('li.download ul.options a');
                var hdLink = videoLinks.first().attr('href');
                var sdLink = videoLinks.last().attr('href');
                var docLink = $('li.document a').first().attr('href');
                callback(null, [hdLink]);
            } else {
                callback(err, response);
            }
        });
    },

    //parse links, generate an info object for each link
    function(videoURLs, callback) {
        console.log(videoURLs.length + " links found");

        callback(null, videoURLs.map(function(url) {
            var group = url.match(videoURLRegex);
            if (group) {
                return {
                    videoURL: group[0],
                    videoURLPrefix: group[1],
                    videoNameWithOutExtension: group[2],
                    subtitleNameForHD: subtitlesFolderForHD + group[2] + ".srt",
                    subtitleNameForSD: subtitlesFolderForSD + group[2].replace("_hd_", "_sd_") + ".srt",
                    webvttFileNames: [],
                    errorMessage: null,
                    skip:false
                };
            } else {
                return null;
            }
        }));
    },

    //check if subtitle file has been downloaded, if so, mark skip to true
    function(videoInfos, callback) {
        videoInfos.forEach(function (videoInfo) {
            videoInfo.skip = fs.existsSync(videoInfo.subtitleNameForHD) && fs.existsSync(videoInfo.subtitleNameForSD);
        });
        callback(null, videoInfos);
    },

    //download subtitle index .m3u8 file and generate webvtt file urls
    function (videoInfos, callback) {
        async.map(videoInfos, function (videoInfo, callback) {
            if (videoInfo.skip) {
                console.log("skip download subtitle of " + videoInfo.videoNameWithOutExtension);
                callback(null, videoInfo);
            } else {
                console.log("start download subtitle index file of " + videoInfo.videoNameWithOutExtension);
                var videoSubtitleIndexFileURL = videoInfo.videoURLPrefix + "subtitles/"+lang+"/prog_index.m3u8";
                request(videoSubtitleIndexFileURL, function (err, response, body) {
                    if (!err && response.statusCode === 200) {
                        var webvttFileNames = body.split("\n").filter(function(line, index) {
                            return line.indexOf("fileSequence") === 0;
                        });
                        webvttFileNames = webvttFileNames.map(function (fileName) {
                            return videoInfo.videoURLPrefix + "subtitles/"+lang+"/"+ fileName;
                        });
                        videoInfo.webvttFileNames = webvttFileNames;
                    } else {
                        var errMsg = "Failed to fetch subtitle index file for video " + videoInfo.videoNameWithOutExtension + ", url:" + videoSubtitleIndexFileURL;
                        videoInfo.errorMessage = errMsg;
                    }
                    callback(null, videoInfo); //ignore the errors, check it in the following step
                });
            }
        }, function (err, videoInfos) {
            callback(null, videoInfos);
        });
    },

    //download webvtt files and combine them to a srt file
    function (videoInfos, callback) {
        async.mapLimit(videoInfos, 100, function (videoInfo, callback) {
            if (!videoInfo.skip && !videoInfo.errorMessage) {
                console.log("start to download webvtt files of " + videoInfo.videoNameWithOutExtension);
                (function (videoInfo) {
                    async.reduce(videoInfo.webvttFileNames, [], function (webvttFilesLines, webvttFileURL, callback) {
                        console.log("start to download webvtt file: " + webvttFileURL);
                        request(webvttFileURL, function(err, response, body) {
                            if (!err && response.statusCode === 200) {
                                var lines = body.split("\n");
                                webvttFilesLines = webvttFilesLines.concat(lines);
                                callback(null, webvttFilesLines);
                            } else {
                                videoInfo.errorMessage = 'cannot download '+webvttFileURL;
                                callback(videoInfo.errorMessage, null);
                            }
                        });
                    }, function (err, webvttFilesLines) {
                        if (webvttFilesLines && webvttFilesLines.length > 0) {
                            webvttFilesLines = webvttFilesLines.filter(function (line) {
                                //remove webvtt file header, they're useless
                                return line.indexOf("WEBVTT") !== 0 && line.indexOf("X-TIMESTAMP-MAP") !== 0;
                            });

                            webvttFilesLines = sutil.webvttLinesToSrtLines(webvttFilesLines);


                            //save to local FS
                            fx.outputFile(videoInfo.subtitleNameForHD, webvttFilesLines.join("\n"), function (err) {
                                if (err) {
                                    videoInfo.errorMessage = "Failed to save subtitles to file " + videoInfo.subtitleNameForHD;
                                    callback(null, videoInfo);
                                } else {
                                    fx.outputFile(videoInfo.subtitleNameForSD, webvttFilesLines.join("\n"), function (err) {
                                        if (err) {
                                            videoInfo.errorMessage = "Failed to save subtitles to file " + videoInfo.subtitleNameForSD;
                                        }
                                        callback(null, videoInfo);
                                    });
                                }
                            });
                        } else {
                            console.log(err);
                        }
                    });
                })(videoInfo);
            } else {
                callback(null, videoInfo);
            }

        }, function (err, videoInfos) {
            callback(null, videoInfos);
        });
    }
], function (err, videoInfos) {
    if (err) {
        console.log("failed to download subtitles, err:" + err);
    } else {
        var totalCount = videoInfos.length;
        var succeedCount = 0;
        var skippedCount = 0;
        videoInfos.forEach(function (videoInfo) {
            if (videoInfo.skip) {
                skippedCount ++;
            } else {
                succeedCount += (!videoInfo.errorMessage ? 1 : 0);
            }
            //if you want error messages, just log down videoInfo.errorMessage
        });

        console.log("======================Finished, success rate: " + succeedCount + "/" + (totalCount - skippedCount) +
            ", " + (totalCount - succeedCount - skippedCount) + " failed, "
            + skippedCount + " skipped ======================");
    }
});

