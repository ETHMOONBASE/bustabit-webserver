 var assert = require('better-assert');
 var async = require('async');
 var timeago = require('timeago');
 var database = require('./database');

 /**
  * GET
  * Public API
  * Show a single game info
  **/
exports.show = function(req, res, next) {
    var user = req.user;
    var gameId = parseInt(req.params.id);

    if (!gameId || typeof gameId !== 'number') return res.render('404');

    database.getGame(gameId, function(err, game) {
        if (err) {
            if (err === 'GAME_DOES_NOT_EXISTS')
                return res.render('404');

            return next(new Error('Unable to get game: \n' + err));
        }

        database.getGamesPlays(game.id, function(err, plays) {
            if (err)
                return next(new Error('Unable to get game information: \n' + err)); //If getGame worked this should work too

            game.timeago = timeago(game.created);
            res.render('game', { game: game, plays: plays, user: user });
        });
    });
};

 /**
  * GET
  * Public API
  * Shows the leader board
  **/
exports.getLeaderBoard = function(req, res, next) {
    var user = req.user;
    var by = req.query.by;
    var last24 = req.query.last24 || null;

    var byDb, order;
    switch(by) {
        case 'net_desc':
            byDb = 'net_profit';
            order = 'DESC';
            break;
        case 'net_asc':
            byDb = 'net_profit';
            order = 'ASC';
            break;
        default :
            byDb = 'gross_profit';
            order = 'DESC';
    }

    if(last24){
        database.getLeaderBoard24(byDb, order ,function(err, leaders) {
            if (err)
                return next(new Error('Unable to get leader board: \n' + err));

            res.render('leaderboard', { user: user, leaders: leaders, sortBy: byDb, order: order, last24: true });
        });
    }else{
        database.getLeaderBoard(byDb, order ,function(err, leaders) {
            if (err)
                return next(new Error('Unable to get leader board: \n' + err));

            res.render('leaderboard', { user: user, leaders: leaders, sortBy: byDb, order: order, last24: false });
        });
    }
};

 /**
  * GET
  * Restricted API
  * Show the current contest page
  **/
exports.getContest = function(req, res, next) {
    var user = req.user;

    var byDb = "net_profit";
    var order = "DESC";

    database.getContestLeaderboard(byDb, order, function(err, leaders) {
        res.render('contest', { user: user, leaders: leaders.slice(0, 20), sortBy: byDb, order: order, last24: true });
    });
};

/**
  * GET
  * Public API
  * Show a single game info
  **/
 exports.getGameInfoJson = function(req, res, next) {
    var gameId = parseInt(req.params.id);

    if (!gameId || typeof gameId !== 'number')
        return res.sendStatus(400);

    database.getGameInfo(gameId, function(err, game) {
        if (err) {
            if (err === 'GAME_DOES_NOT_EXISTS')
                return res.json(err);

            console.error('[INTERNAL_ERROR] Unable to get game info. gameId: ', gameId);
            return res.sendStatus(500);
        }
        res.json(game);
    });
 };