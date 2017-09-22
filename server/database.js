var assert = require('assert');
var uuid = require('uuid');
var config = require('../config/config');

var async = require('async');
var lib = require('./lib');
var pg = require('pg');
var passwordHash = require('password-hash');
var speakeasy = require('speakeasy');
var m = require('multiline');

var databaseUrl = config.DATABASE_URL;

if (!databaseUrl)
    throw new Error('must set DATABASE_URL environment var');

console.log('DATABASE_URL: ', databaseUrl);

pg.types.setTypeParser(20, function(val) { // parse int8 as an integer
    return val === null ? null : parseInt(val);
});

// callback is called with (err, client, done)
function connect(callback) {
    return pg.connect(databaseUrl, callback);
}

function query(query, params, callback) {
    //third parameter is optional
    if (typeof params == 'function') {
        callback = params;
        params = [];
    }

    doIt();
    function doIt() {
        connect(function(err, client, done) {
            if (err) return callback(err);
            client.query(query, params, function(err, result) {
                done();
                if (err) {
                    if (err.code === '40P01') {
                        console.log('Warning: Retrying deadlocked transaction: ', query, params);
                        return doIt();
                    }
                    return callback(err);
                }

                callback(null, result);
            });
        });
    }
}

exports.query = query;

pg.on('error', function(err) {
    console.error('POSTGRES EMITTED AN ERROR', err);
});


// runner takes (client, callback)

// callback should be called with (err, data)
// client should not be used to commit, rollback or start a new transaction

// callback takes (err, data)

function getClient(runner, callback) {
    doIt();

    function doIt() {
        connect(function (err, client, done) {
            if (err) return callback(err);

            function rollback(err) {
                client.query('ROLLBACK', done);

                if (err.code === '40P01') {
                    console.log('Warning: Retrying deadlocked transaction..');
                    return doIt();
                }

                callback(err);
            }

            client.query('BEGIN', function (err) {
                if (err)
                    return rollback(err);

                runner(client, function (err, data) {
                    if (err)
                        return rollback(err);

                    client.query('COMMIT', function (err) {
                        if (err)
                            return rollback(err);

                        done();
                        callback(null, data);
                    });
                });
            });
        });
    }
}

//Returns a sessionId
exports.createUser = function(username, password, email, ipAddress, userAgent, callback) {
    assert(username && password);

    getClient(
        function(client, callback) {
            var hashedPassword = passwordHash.generate(password);

            client.query('SELECT COUNT(*) count FROM users WHERE lower(username) = lower($1)', [username],
                function(err, data) {
                    if (err) return callback(err);
                    assert(data.rows.length === 1);
                    if (data.rows[0].count > 0)
                        return callback('USERNAME_TAKEN');

                    client.query('INSERT INTO users(username, email, password) VALUES($1, $2, $3) RETURNING id',
                            [username, email, hashedPassword],
                            function(err, data) {
                                if (err)  {
                                    if (err.code === '23505')
                                        return callback('USERNAME_TAKEN');
                                    else
                                        return callback(err);
                                }

                                assert(data.rows.length === 1);
                                var user = data.rows[0];

                                require(process.env.DEPOSITOR_TAGS).generate((err) => {
                                    if(err) console.error(err);
                                    createSession(client, user.id, ipAddress, userAgent, false, callback);
                                });
                            }
                        );

                    });
        }
    , callback);
};

exports.updateEmail = function(userId, email, callback) {
    assert(userId);

    query('UPDATE users SET email = $1 WHERE id = $2', [email, userId], function(err, res) {
        if(err) return callback(err);

        assert(res.rowCount === 1);
        callback(null);
    });

};

exports.changeUserPassword = function(userId, password, callback) {
    assert(userId && password && callback);
    var hashedPassword = passwordHash.generate(password);
    query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, userId], function(err, res) {
        if (err) return callback(err);
        assert(res.rowCount === 1);
        callback(null);
    });
};

exports.updateMfa = function(userId, secret, callback) {
    assert(userId);
    query('UPDATE users SET mfa_secret = $1 WHERE id = $2', [secret, userId], callback);
};

// Possible errors:
//   NO_USER, WRONG_PASSWORD, INVALID_OTP
exports.validateUser = function(username, password, otp, callback) {
    assert(username && password);

    query('SELECT id, password, mfa_secret FROM users WHERE lower(username) = lower($1)', [username], function (err, data) {
        if (err) return callback(err);

        if (data.rows.length === 0)
            return callback('NO_USER');

        var user = data.rows[0];

        var verified = passwordHash.verify(password, user.password);
        if (!verified)
            return callback('WRONG_PASSWORD');

        if (user.mfa_secret) {
            if (!otp) return callback('INVALID_OTP'); // really, just needs one

            var expected = speakeasy.totp({ key: user.mfa_secret, encoding: 'base32' });

            if (otp !== expected)
                return callback('INVALID_OTP');
        }

        callback(null, user.id);
    });
};

/** Expire all the not expired sessions of an user by id **/
exports.expireSessionsByUserId = function(userId, callback) {
    assert(userId);

    query('UPDATE sessions SET expired = now() WHERE user_id = $1 AND expired > now()', [userId], callback);
};


function createSession(client, userId, ipAddress, userAgent, remember, callback) {
    var sessionId = uuid.v4();

    var expired = new Date();
    if (remember)
        expired.setFullYear(expired.getFullYear() + 10);
    else
        expired.setDate(expired.getDate() + 21);

    client.query('INSERT INTO sessions(id, user_id, ip_address, user_agent, expired) VALUES($1, $2, $3, $4, $5) RETURNING id',
        [sessionId, userId, ipAddress, userAgent, expired], function(err, res) {
        if (err) return callback(err);
        assert(res.rows.length === 1);

        var session = res.rows[0];
        assert(session.id);

        callback(null, session.id, expired);
    });
}

exports.createOneTimeToken = function(userId, ipAddress, userAgent, callback) {
    assert(userId);
    var id = uuid.v4();

    query('INSERT INTO sessions(id, user_id, ip_address, user_agent, ott) VALUES($1, $2, $3, $4, true) RETURNING id', [id, userId, ipAddress, userAgent], function(err, result) {
        if (err) return callback(err);
        assert(result.rows.length === 1);

        var ott = result.rows[0];

        callback(null, ott.id);
    });
};

exports.createSession = function(userId, ipAddress, userAgent, remember, callback) {
    assert(userId && callback);

    getClient(function(client, callback) {
        createSession(client, userId, ipAddress, userAgent, remember, callback);
    }, callback);

};

exports.getUserFromUsername = function(username, callback) {
    assert(username && callback);

    query('SELECT * FROM users_view WHERE lower(username) = lower($1)', [username], function(err, data) {
        if (err) return callback(err);

        if (data.rows.length === 0)
            return callback('NO_USER');

        assert(data.rows.length === 1);
        var user = data.rows[0];
        assert(typeof user.balance_satoshis === 'number');

        callback(null, user);
    });
};

exports.getUsersFromEmail = function(email, callback) {
    assert(email, callback);

    query('select * from users where email = lower($1)', [email], function(err, data) {
       if (err) return callback(err);

        if (data.rows.length === 0)
            return callback('NO_USERS');

        callback(null, data.rows);

    });
};

exports.addRecoverId = function(userId, ipAddress, callback) {
    assert(userId && ipAddress && callback);

    var recoveryId = uuid.v4();

    query('INSERT INTO recovery (id, user_id, ip)  values($1, $2, $3)', [recoveryId, userId, ipAddress], function(err, res) {
        if (err) return callback(err);
        callback(null, recoveryId);
    });
};

exports.getUserBySessionId = function(sessionId, callback) {
    assert(sessionId && callback);
    query('SELECT * FROM users_view WHERE id = (SELECT user_id FROM sessions WHERE id = $1 AND ott = false AND expired > now())', [sessionId], function(err, response) {
        if (err) return callback(err);

        var data = response.rows;
        if (data.length === 0)
            return callback('NOT_VALID_SESSION');

        assert(data.length === 1);

        var user = data[0];
        assert(typeof user.balance_satoshis === 'number');

        callback(null, user);
    });
};

exports.findSessionsFromIpAddress = function(ipAddress, callback){
    assert(ipAddress, callback);
    query('SELECT * FROM sessions WHERE ip_address = $1', [ipAddress], function(err, results) {
        if(err) return callback(err);
        callback(null, results);
    });
};

exports.getSessionByUserId = function(userId, callback) {
    assert(userId, callback);
    query('SELECT * FROM sessions WHERE user_id = $1 ORDER BY created DESC', [userId], function(err, results) {
        if(err) return callback(err);
        callback(null, results);
    });
};

exports.getUserByValidRecoverId = function(recoverId, callback) {
    assert(recoverId && callback);
    query('SELECT * FROM users_view WHERE id = (SELECT user_id FROM recovery WHERE id = $1 AND used = false AND expired > NOW())', [recoverId], function(err, res) {
        if (err) return callback(err);

        var data = res.rows;
        if (data.length === 0)
            return callback('NOT_VALID_RECOVER_ID');

        assert(data.length === 1);
        return callback(null, data[0]);
    });
};

exports.getUserByName = function(username, callback) {
    assert(username);
    query('SELECT * FROM users WHERE lower(username) = lower($1)', [username], function(err, result) {
        if (err) return callback(err);
        if (result.rows.length === 0)
            return callback('USER_DOES_NOT_EXIST');

        assert(result.rows.length === 1);
        callback(null, result.rows[0]);
    });
};

/* Sets the recovery record to userd and update password */
exports.changePasswordFromRecoverId = function(recoverId, password, callback) {
    assert(recoverId && password && callback);
    var hashedPassword = passwordHash.generate(password);

    var sql = m(function() {/*
     WITH t as (UPDATE recovery SET used = true, expired = now()
     WHERE id = $1 AND used = false AND expired > now()
     RETURNING *) UPDATE users SET password = $2 where id = (SELECT user_id FROM t) RETURNING *
     */});

    query(sql, [recoverId, hashedPassword], function(err, res) {
            if (err)
                return callback(err);

            var data = res.rows;
            if (data.length === 0)
                return callback('NOT_VALID_RECOVER_ID');

            assert(data.length === 1);

            callback(null, data[0]);
        }
    );
};

exports.getGame = function(gameId, callback) {
    assert(gameId && callback);

    query('SELECT * FROM games ' +
    'LEFT JOIN game_hashes ON games.id = game_hashes.game_id ' +
    'WHERE games.id = $1 AND games.ended = TRUE', [gameId], function(err, result) {
        if (err) return callback(err);
        if (result.rows.length == 0) return callback('GAME_DOES_NOT_EXISTS');
        assert(result.rows.length == 1);
        callback(null, result.rows[0]);
    });
};

exports.getGamesPlays = function(gameId, callback) {
    query('SELECT u.username, p.bet, p.cash_out, p.bonus FROM plays p, users u ' +
        ' WHERE game_id = $1 AND p.user_id = u.id ORDER by p.cash_out/p.bet::float DESC NULLS LAST, p.bet DESC', [gameId],
        function(err, result) {
            if (err) return callback(err);
            return callback(null, result.rows);
        }
    );
};

exports.getGameInfo = function(gameId, callback) {
    assert(gameId && callback);

    var gameInfo = { game_id: gameId };

    function getSqlGame(callback) {

        var sqlGame = m(function() {/*
         SELECT game_crash, created, hash
         FROM games LEFT JOIN game_hashes ON games.id = game_id
         WHERE games.ended = true AND games.id = $1
         */});

        query(sqlGame, [gameId], function(err, result) {
            if(err)
                return callback(err);

            if (result.rows.length === 0)
                return callback('GAME_DOES_NOT_EXISTS');

            console.assert(result.rows.length === 1);

            var game = result.rows[0];

            gameInfo.game_crash = game.game_crash;
            gameInfo.hash = game.hash;
            gameInfo.created = game.created;

            callback(null);
        });
    }

    function getSqlPlays(callback) {
        var sqlPlays = m(function() {/*
         SELECT username, bet, (100 * cash_out / bet)::bigint AS stopped_at, bonus
         FROM plays JOIN users ON user_id = users.id WHERE game_id = $1
         */});

        query(sqlPlays, [gameId], function(err, result) {
            if(err)
                return callback(err);

            var playsArr = result.rows;

            var player_info = {};
            playsArr.forEach(function(play) {
                player_info[play.username] = {
                    bet: play.bet,
                    stopped_at: play.stopped_at,
                    bonus: play.bonus
                };
            });

            gameInfo.player_info = player_info;

            callback(null);
        });
    }


    async.parallel([getSqlGame, getSqlPlays],
    function(err, results) {
        if(err)
            return callback(err);

        callback(null, gameInfo);
    });
};

function addSatoshis(client, userId, amount, callback) {

    client.query('UPDATE users SET balance_satoshis = balance_satoshis + $1 WHERE id = $2', [amount, userId], function(err, res) {
        if (err) return callback(err);
        assert(res.rowCount === 1);
        callback(null);
    });
}

exports.getUserPlays = function(userId, limit, offset, callback) {
    assert(userId);

    query('SELECT p.bet, p.bonus, p.cash_out, p.created, p.game_id, g.game_crash FROM plays p ' +
        'LEFT JOIN (SELECT * FROM games) g ON g.id = p.game_id ' +
        'WHERE p.user_id = $1 AND g.ended = true ORDER BY p.id DESC LIMIT $2 OFFSET $3',
        [userId, limit, offset], function(err, result) {
            if (err) return callback(err);
            callback(null, result.rows);
        }
    );
};

exports.getGiveAwaysAmount = function(userId, callback) {
    assert(userId);
    query('SELECT SUM(g.amount) FROM giveaways g where user_id = $1', [userId], function(err,result) {
        if (err) return callback(err);
        return callback(null, result.rows[0]);
    });
};

exports.addGiveaway = function(userId, callback) {
    assert(userId && callback);
    getClient(function(client, callback) {

            client.query('SELECT last_giveaway FROM users_view WHERE id = $1', [userId] , function(err, result) {
                if (err) return callback(err);

                if (!result.rows) return callback('USER_DOES_NOT_EXIST');
                assert(result.rows.length === 1);
                var lastGiveaway = result.rows[0].last_giveaway;
                var eligible = lib.isEligibleForGiveAway(lastGiveaway);

                if (typeof eligible === 'number') {
                    return callback({ message: 'NOT_ELIGIBLE', time: eligible});
                }

                var amount = 200; // 2 bits
                client.query('INSERT INTO giveaways(user_id, amount) VALUES($1, $2) ', [userId, amount], function(err) {
                    if (err) return callback(err);

                    addSatoshis(client, userId, amount, function(err) {
                        if (err) return callback(err);

                        callback(null);
                    });
                });
            });

        }, callback
    );
};

exports.addRawGiveaway = function(userNames, amount, callback) {
    assert(userNames && amount && callback);

    getClient(function(client, callback) {

        var tasks = userNames.map(function(username) {
            return function(callback) {

                client.query('SELECT id FROM users WHERE lower(username) = lower($1)', [username], function(err, result) {
                    if (err) return callback('unable to add bits');

                    if (result.rows.length === 0) return callback(username + ' didnt exists');

                    var userId = result.rows[0].id;
                    client.query('INSERT INTO giveaways(user_id, amount) VALUES($1, $2) ', [userId, amount], function(err, result) {
                        if (err) return callback(err);

                        assert(result.rowCount == 1);
                        addSatoshis(client, userId, amount, function(err) {
                            if (err) return callback(err);
                            callback(null);
                        });
                    });
                });
            };
        });

        async.series(tasks, function(err, ret) {
            if (err) return callback(err);
            return callback(null, ret);
        });

    }, callback);
};

exports.getUserNetProfit = function(userId, callback) {
    assert(userId);
    query('SELECT (' +
            'COALESCE(SUM(cash_out), 0) + ' +
            'COALESCE(SUM(bonus), 0) - ' +
            'COALESCE(SUM(bet), 0)) profit ' +
        'FROM plays ' +
        'WHERE user_id = $1', [userId], function(err, result) {
            if (err) return callback(err);
            assert(result.rows.length == 1);
            return callback(null, result.rows[0]);
        }
    );
};

exports.getUserNetProfitLast = function(userId, last, callback) {
    assert(userId);
    query('SELECT (' +
            'COALESCE(SUM(cash_out), 0) + ' +
            'COALESCE(SUM(bonus), 0) - ' +
            'COALESCE(SUM(bet), 0))::bigint profit ' +
            'FROM ( ' +
                'SELECT * FROM plays ' +
                'WHERE user_id = $1 ' +
                'ORDER BY id DESC ' +
                'LIMIT $2 ' +
            ') restricted ', [userId, last], function(err, result) {
            if (err) return callback(err);
            assert(result.rows.length == 1);
            return callback(null, result.rows[0].profit);
        }
    );
};

exports.getPublicStats = function(username, callback) {

  var sql = 'SELECT id AS user_id, username, gross_profit, net_profit, games_played, ' +
            'COALESCE((SELECT rank FROM leaderboard WHERE user_id = id), -1) rank ' +
            'FROM users WHERE lower(username) = lower($1)';

    query(sql,
        [username], function(err, result) {
            if (err) return callback(err);

            if (result.rows.length !== 1)
                return callback('USER_DOES_NOT_EXIST');

            return callback(null, result.rows[0]);
        }
    );
};

exports.cancelWithdrawal = function(userId, satoshis, withdrawalId, callback){
    assert(typeof userId === 'number');
    assert(typeof satoshis === 'number');
    assert(lib.isUUIDv4(withdrawalId));

    getClient(function(client, callback) {
        client.query('DELETE FROM fundings WHERE user_id = $1 AND withdrawal_id = $2',
            [userId, withdrawalId],
            function(err, response) {
                if (err){
                    return callback(err);
                }
                client.query("UPDATE users SET balance_satoshis = balance_satoshis + $1 WHERE id = $2",
                    [satoshis, userId], function(err, response) {
                    if (err) return callback(err);

                    if (response.rowCount !== 1)
                        return callback(new Error('Unexpected withdrawal row count: \n' + response));

                    callback(null);
                });
            }
        );
    }, callback);
}

exports.makeTransfer = function(uid, fromUserId, toUsername, satoshis, callback){
    assert(typeof fromUserId === 'number');
    assert(typeof toUsername === 'string');
    assert(typeof satoshis === 'number');

    // Update balances
    getClient(function(client, callback) {
        async.waterfall([
            function(callback) {
                client.query("UPDATE users SET balance_satoshis = balance_satoshis - $1 WHERE id = $2",
                  [satoshis, fromUserId], callback)
            },
            function(prevData, callback) {
                client.query(
                  "UPDATE users SET balance_satoshis = balance_satoshis + $1 WHERE lower(username) = lower($2) RETURNING id",
                  [satoshis, toUsername], function(err, data) {
                      if (err)
                          return callback(err);
                      if (data.rowCount === 0)
                        return callback('USER_NOT_EXIST');
                      var toUserId = data.rows[0].id;
                      assert(Number.isInteger(toUserId));
                      callback(null, toUserId);
                  });
            },
            function (toUserId, callback) {
                client.query(
                  "INSERT INTO transfers (id, from_user_id, to_user_id, amount) values($1,$2,$3,$4) ",
                  [uid, fromUserId, toUserId, satoshis], callback);
            }
        ], function(err) {
            if (err) {
                if (err.code === '23514') {// constraint violation
                    return callback('NOT_ENOUGH_BALANCE');
                }
                if (err.code === '23505') { // dupe key
                    return callback('TRANSFER_ALREADY_MADE');
                }

                return callback(err);
            }
            callback();
        });
    }, callback);

};

exports.verifyUsersWithdrawals = function(userId, callback) {
    assert(typeof userId === 'number');

    getClient(function(client, callback) {
        client.query("SELECT * FROM fundings WHERE user_id = $1 AND amount < 0 AND bitcoin_withdrawal_txid IS NULL", [userId], function(err, response) {
            if(err) return callback(err);
            if(response.rowCount > 0) return callback("block");
            callback(null);
        });
    }, callback);
};

exports.prepareWithdraw = function(userId, satoshis, withdrawalId, callback) {
    assert(typeof userId === 'number');
    assert(typeof satoshis === 'number');
    assert(satoshis >= 100);
    assert(lib.isUUIDv4(withdrawalId));

    getClient(function(client, callback) {
        client.query("SELECT balance_satoshis FROM users WHERE id=$1", [userId], function(err, response) {
            if (err) return callback(err);

            if (response.rowCount !== 1)
                return callback(new Error('Unexpected withdrawal users row count: \n' + response));

            var user_balance = response.rows[0].balance_satoshis;

            if(user_balance >= satoshis){
                client.query("SELECT * FROM fundings WHERE withdrawal_id=$1", [withdrawalId], function(err, response) {
                    if (err) return callback(err);
                    if (response.rowCount !== 0){
                        return callback('SAME_WITHDRAWAL_ID');
                    }else{
                        return callback(null);
                    }
                });
            }else{
                return callback('NOT_ENOUGH_MONEY');
            }
        });
    }, callback);
};

exports.makeWithdrawal = function(userId, satoshis, withdrawalAddress, withdrawalId, callback) {
    assert(typeof userId === 'number');
    assert(typeof satoshis === 'number');
    assert(typeof withdrawalAddress === 'string');
    assert(satoshis >= 100);
    assert(lib.isUUIDv4(withdrawalId));

    getClient(function(client, callback) {

        client.query("UPDATE users SET balance_satoshis = balance_satoshis - $1 WHERE id = $2",
            [satoshis, userId], function(err, response) {
            if (err) return callback(err);

            if (response.rowCount !== 1)
                return callback(new Error('Unexpected withdrawal row count: \n' + response));

            client.query('INSERT INTO fundings(user_id, amount, bitcoin_withdrawal_address, withdrawal_id) ' +
                "VALUES($1, $2, $3, $4) RETURNING id",
                [userId, -1 * satoshis, withdrawalAddress, withdrawalId],
                function(err, response) {
                    if (err) return callback(err);

                    var fundingId = response.rows[0].id;
                    assert(typeof fundingId === 'number');

                    callback(null, fundingId);
                }
            );
        });

    }, callback);
};

exports.getWithdrawals = function(userId, callback) {
    assert(userId && callback);

    query("SELECT * FROM fundings WHERE user_id = $1 AND amount < 0 ORDER BY created DESC", [userId], function(err, result) {
        if (err) return callback(err);

        var data = result.rows.map(function(row) {
           return {
               amount: Math.abs(row.amount),
               destination: row.bitcoin_withdrawal_address,
               status: row.bitcoin_withdrawal_txid,
               created: row.created
           };
        });
        callback(null, data);
    });
};

exports.getTransfers = function (userId, callback){
    assert(userId);
    assert(callback);

    var sql = m(function() {/*
        SELECT
           transfers.id,
           transfers.amount,
           (SELECT username FROM users WHERE id = transfers.from_user_id) AS from_username,
           (SELECT username FROM users WHERE id = transfers.to_user_id) AS to_username,
           transfers.created
        FROM transfers
        WHERE from_user_id = $1
           OR   to_user_id = $1
        ORDER by transfers.created DESC
        LIMIT 250
    */});

    query(sql, [userId], function(err, data) {
        if (err)
            return callback(err);

        callback(null, data.rows);
    });
};

exports.getDeposits = function(userId, callback) {
    assert(userId && callback);

    query("SELECT * FROM fundings WHERE user_id = $1 AND amount > 0 ORDER BY created DESC", [userId], function(err, result) {
        if (err) return callback(err);

        var data = result.rows.map(function(row) {
            return {
                amount: row.amount,
                txid: row.bitcoin_deposit_txid,
                created: row.created
            };
        });
        callback(null, data);
    });
};

exports.getInvestment = function(userId, callback) {
    assert(userId && callback);

    query("SELECT * FROM investments WHERE user_id = $1", [userId], function(err, result) {
        if (err) return callback(err);

        if(result.rows.length == 1)
            callback(null, result.rows[0]);
        else
            callback(null, null);
    });
};

exports.getInvestments = function(userId, callback) {
    assert(callback);

    if(!userId){
        query("SELECT SUM(amount) as amount FROM investments_history ORDER BY created ASC", function(err, result) {
            if (err) return callback(err);
            callback(null, result.rows[0]);
        });
    }else{
        query("SELECT * FROM investments_history WHERE user_id = $1 ORDER BY created DESC", [userId], function(err, result) {
            if (err) return callback(err);

            var data = result.rows.map(function(row) {
                return {
                    amount: row.amount,
                    created: row.created,
                    done: row.done
                };
            });
            callback(null, data);
        });
    }
};

exports.getDepositsAmount = function(userId, callback) {
    assert(userId);
    query('SELECT SUM(f.amount) FROM fundings f WHERE user_id = $1 AND amount >= 0', [userId], function(err, result) {
        if (err) return callback(err);
        callback(null, result.rows[0]);
    });
};

exports.getWithdrawalsAmount = function(userId, callback) {
    assert(userId);
    query('SELECT SUM(f.amount) FROM fundings f WHERE user_id = $1 AND amount < 0', [userId], function(err, result) {
        if (err) return callback(err);

        callback(null, result.rows[0]);
    });
};

exports.getBankroll = function(callback) {
    query('SELECT ' +
        'COUNT(*) count, ' +
        'SUM(plays.bet)::bigint total_bet, ' +
        'SUM(plays.cash_out)::bigint cashed_out, ' +
        'SUM(plays.bonus)::bigint bonused ' +
        'FROM plays',
        function(err, results) {
            if (err) return callback(err);

            assert(results.rows.length === 1);

            query('SELECT SUM(investments_history.amount)::bigint total_invested FROM investments_history WHERE done = true', (err, result_investments) => {
                var profit = 5000e8 + (results.rows[0].total_bet - results.rows[0].cashed_out - results.rows[0].bonused) + result_investments.rows[0].total_invested;
                assert(typeof profit === 'number');

                var min = 1e8;

                callback(null, Math.max(min, profit));
            });
        }
    );
};

exports.setFundingsWithdrawalTxid = function(fundingId, txid, callback) {
    assert(typeof fundingId === 'number');
    assert(typeof txid === 'string');
    assert(callback);

    query('UPDATE fundings SET bitcoin_withdrawal_txid = $1 WHERE id = $2', [txid, fundingId],
        function(err, result) {
           if (err) return callback(err);

            assert(result.rowCount === 1);

            callback(null);
        }
    );
};


exports.getLeaderBoard = function(byDb, order, callback) {
    var sql = 'SELECT * FROM leaderboard ORDER BY ' + byDb + ' ' + order + ' LIMIT 100';
    query(sql, function(err, data) {
        if (err)
            return callback(err);
        callback(null, data.rows);
    });
};

exports.getLeaderBoard24 = function(byDb, order, callback) {
    var now = new Date();
    var last24 = new Date(new Date(now).setHours(now.getHours()-24)).toISOString();

    var sql = "SELECT p.*, u.username FROM users u INNER JOIN( SELECT * FROM plays WHERE created <= now() AND created >= '"+last24+"' order by id desc ) as p on p.user_id = u.id";
    query(sql, function(err, data) {
        if (err)
          return callback(err);

        var rows = data.rows;
        var pre_leaderboard = {};
        var leaderboard = [];
        for(var i in rows){
            var row = rows[i];
            if(!pre_leaderboard[row.username]){
              pre_leaderboard[row.username] = {
                user_id: row.user_id,
                username: row.username,
                gross_profit: 0,
                net_profit: 0
              };
            }

            var bonus = row.bonus || 0;
            var cashout = row.cash_out || 0;
            var bet = row.bet;

            pre_leaderboard[row.username].gross_profit += Math.max(cashout - bet, 0) + bonus;
            pre_leaderboard[row.username].net_profit += (cashout - bet) + bonus;
        }

        for(var i in pre_leaderboard){
            leaderboard.push(pre_leaderboard[i]);
        }

        if(byDb == 'net_profit'){
            if(order == 'DESC'){
                leaderboard.sort(function(a, b){
                   return b.net_profit - a.net_profit;
                });
            }else if(order == 'ASC'){
                leaderboard.sort(function(a, b){
                   return a.net_profit - b.net_profit;
                });
            }
        }else if(byDb == 'gross_profit'){
            if(order == 'DESC'){
                leaderboard.sort(function(a, b){
                   return b.gross_profit - a.gross_profit;
                });
            }
        }

        callback(null, leaderboard.slice(0, (leaderboard.length>=100 ? 100 : leaderboard.length)));
    });
};

exports.getContestLeaderboard = function(byDb, order, callback) {
    var now = new Date();
    var last24 = new Date(new Date(now).setHours(now.getHours()-24)).toISOString();

    var eastern = new Date((new Date(new Date().getTime()).getTime() + (3600000*-4)));
    var startingDate;
    if(new Date(eastern).getHours() > 0){
      var d = new Date(eastern);
      d.setHours(4,0,0,0);

      startingDate = d;
    }else{
      if(new Date(eastern).getMinutes() >= 1){
        var d = new Date(eastern);
        d.setHours(4,0,0,0);

        startingDate = d;
      }else{
        var d = new Date(eastern);
        d.setDate(d.getDate()-1);
        d.setHours(4,0,0,0);

        startingDate = d;
      }
    }

    var sql = "SELECT p.*, u.username FROM users u INNER JOIN( SELECT * FROM plays WHERE created <= now() AND created >= '"+startingDate.toISOString()+"' order by id desc ) as p on p.user_id = u.id";
    query(sql, function(err, data) {
        if (err)
            return callback(err);

        var rows = data.rows;
        var pre_leaderboard = {};
        var leaderboard = [];
        for(var i in rows){
            var row = rows[i];
            if(row.username == "Dexon" || row.username == "Administrator" || row.username == "MrBlade") continue;
            if(!pre_leaderboard[row.username]){
                pre_leaderboard[row.username] = {
                    user_id: row.user_id,
                    username: row.username,
                    gross_profit: 0,
                    net_profit: 0
                };
            }

            var bonus = row.bonus || 0;
            var cashout = row.cash_out || 0;
            var bet = row.bet;

            pre_leaderboard[row.username].gross_profit += Math.max(cashout - bet, 0) + bonus;
            pre_leaderboard[row.username].net_profit += (cashout - bet) + bonus;
        }

        for(var i in pre_leaderboard){
            leaderboard.push(pre_leaderboard[i]);
        }

        if(byDb == 'net_profit'){
            if(order == 'DESC'){
                leaderboard.sort(function(a, b){
                   return b.net_profit - a.net_profit;
                });
            }else if(order == 'ASC'){
                leaderboard.sort(function(a, b){
                   return a.net_profit - b.net_profit;
                });
            }
        }else if(byDb == 'gross_profit'){
            if(order == 'DESC'){
                leaderboard.sort(function(a, b){
                   return b.gross_profit - a.gross_profit;
                });
            }
        }

        callback(null, leaderboard.slice(0, (leaderboard.length>=100 ? 100 : leaderboard.length)));
    });
};

exports.addChatMessage = function(userId, created, message, channelName, isBot, callback) {
    var sql = 'INSERT INTO chat_messages (user_id, created, message, channel, is_bot) values($1, $2, $3, $4, $5)';
    query(sql, [userId, created, message, channelName, isBot], function(err, res) {
        if(err)
            return callback(err);

        assert(res.rowCount === 1);

        callback(null);
    });
};

exports.getChatTable = function(limit, channelName, callback) {
    assert(typeof limit === 'number');
    var sql = "SELECT chat_messages.created AS date, 'say' AS type, users.username, users.userclass AS role, chat_messages.message, is_bot AS bot " +
        "FROM chat_messages JOIN users ON users.id = chat_messages.user_id WHERE channel = $1 ORDER BY chat_messages.id DESC LIMIT $2";
    query(sql, [channelName, limit], function(err, data) {
        if(err)
            return callback(err);
        callback(null, data.rows);
    });
};

//Get the history of the chat of all channels except the mods channel
exports.getAllChatTable = function(limit, callback) {
    assert(typeof limit === 'number');
    var sql = m(function(){/*
     SELECT chat_messages.created AS date, 'say' AS type, users.username, users.userclass AS role, chat_messages.message, is_bot AS bot, chat_messages.channel AS "channelName"
     FROM chat_messages JOIN users ON users.id = chat_messages.user_id WHERE channel <> 'moderators'  ORDER BY chat_messages.id DESC LIMIT $1
    */});
    query(sql, [limit], function(err, data) {
        if(err)
            return callback(err);
        callback(null, data.rows);
    });
};

exports.getSiteStats = function(callback) {

    function as(name, callback) {
        return function(err, results) {
            if (err)
                return callback(err);

            assert(results.rows.length === 1);
            callback(null, [name, results.rows[0]]);
        }
    }

    var tasks = [
        function(callback) {
            query('SELECT COUNT(*) FROM users', as('users', callback));
        },
        function (callback) {
            query('SELECT COUNT(*) FROM games', as('games', callback));
        },
        function(callback) {
            query('SELECT COALESCE(SUM(fundings.amount), 0)::bigint sum FROM fundings WHERE amount < 0', as('withdrawals', callback));
        },
        function(callback) {
            query("SELECT COUNT(*) FROM games WHERE ended = false AND created < NOW() - interval '5 minutes'", as('unterminated_games', callback));
        },
        function(callback) {
            query('SELECT COUNT(*) FROM fundings WHERE amount < 0 AND bitcoin_withdrawal_txid IS NULL', as('pending_withdrawals', callback));
        },
        function(callback) {
            query('SELECT COALESCE(SUM(fundings.amount), 0)::bigint sum FROM fundings WHERE amount > 0', as('deposits', callback));
        },
        function(callback) {
            query('SELECT COALESCE(SUM(investments.amount), 0)::bigint sum FROM investments WHERE amount > 0', as('investments', callback));
        },
        function(callback) {
            query('SELECT COALESCE(SUM(investments_history.amount), 0)::bigint sum FROM investments_history WHERE done = true', as('total_invested', callback));
        },
        function(callback) {
            query('SELECT ' +
                'COUNT(*) count, ' +
                'SUM(plays.bet)::bigint total_bet, ' +
                'SUM(plays.cash_out)::bigint cashed_out, ' +
                'SUM(plays.bonus)::bigint bonused ' +
                'FROM plays', as('plays', callback));
        }
    ];

    async.series(tasks, function(err, results) {
       if (err) return callback(err);

       var data = {};

        results.forEach(function(entry) {
           data[entry[0]] = entry[1];
        });

        callback(null, data);
    });

};
