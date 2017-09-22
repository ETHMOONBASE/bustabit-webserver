var assert = require('assert');
var async = require('async');
var database = require('./database');
var config = require('../config/config');

/**
 * The req.user.admin is inserted in the user validation middleware
 */

exports.giveAway = function(req, res) {
    var user = req.user;
    assert(user.admin);
    res.render('giveaway', { user: user });
};

exports.contest = function(req, res) {
    var user = req.user;
    assert(user.admin);

    var byDb = "net_profit";
    var order = "DESC";

    database.getContestLeaderboard(byDb, order, function(err, leaders) {
        var winners = {};
        var usersIP = {};

        var tasks = [];

        tasks.push((callback) => {
            var processed = 0;
            for(var i in leaders){
                var index = i;
                database.getSessionByUserId(leaders[index].user_id, function(err, results) {
                    if(err) return callback(err);
                    for(var ii in results.rows){
                        var entry = results.rows[ii];
                        if(!usersIP[entry.ip_address]){
                            usersIP[entry.ip_address] = [];
                            usersIP[entry.ip_address].push(entry.user_id);
                        }else{
                            if(usersIP[entry.ip_address].indexOf(entry.user_id) == -1)
                                usersIP[entry.ip_address].push(entry.user_id);
                        }
                    }
                    processed++;
                    if(processed >= leaders.length){
                        callback(null);
                    }
                });
            }
        });


        async.series(tasks, function(err) {
            if (err) console.error(err);

            leaders.forEach(function(entry) {
                if(winners.length > 0){
                    loop1:
                    for(var i in winners){
                        loop2:
                        for(var ii in usersIP){
                            if(usersIP[ii].indexOf(winners[i]) >= 0){
                                break loop1;
                            }
                        }
                        winners[entry.user_id] = {
                            user_id: entry.user_id,
                            username: entry.username,
                            net_profit: entry.net_profit
                        };
                    }
                }else{
                    winners[entry.user_id] = {
                        user_id: entry.user_id,
                        username: entry.username,
                        net_profit: entry.net_profit
                    };
                }
            });

            var users = [];
            for(var i in winners){
                users.push(winners[i]);
            }

            users.sort(function(a, b){
               return b.net_profit - a.net_profit;
            });

            var time = new Date().toISOString();
            res.render('admin-contest', { user: user, users: users });
        });
    });
};

exports.giveAwayHandle = function(req, res, next) {
    var user = req.user;
    assert(user.admin);

    if (config.PRODUCTION) {
        var ref = req.get('Referer');
        if (!ref) return next(new Error('Possible xsfr')); //Interesting enough to log it as an error

        if (ref.lastIndexOf('https://www.winxrp.com/admin-giveaway', 0) !== 0)
            return next(new Error('Bad referrer got: ' + ref));
    }

    var giveAwayUsers = req.body.users.split(/\s+/);
    var bits = parseFloat(req.body.bits);

    if (!Number.isFinite(bits) || bits <= 0)
        return next('Problem with rips...');

    var satoshis = Math.round(bits * 100);

    database.addRawGiveaway(giveAwayUsers, satoshis , function(err) {
        if (err) return res.redirect('/admin-giveaway?err=' + err);

        res.redirect('/admin-giveaway?m=Done');
    });
};