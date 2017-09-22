var assert = require('assert');
var RippleAPI = require('ripple-lib').RippleAPI;
var bc = require('./bitcoin_client');
var db = require('./database');
var request = require('request');
var config = require('../config/config');


// Doesn't validate
module.exports = function(userId, satoshis, withdrawalAddress, withdrawalId, withdrawalTag, callback) {
    if(typeof callback != "function"){
        callback = withdrawalTag;
        withdrawalTag = null;
    }

    var api = new RippleAPI({
        server: require(process.env.DEPOSITOR_CONFIGS)["XRP_API_URL"]
    });

    api.connect().then(() => {
      api.getFee().then(fee => {
        var fee = 0.02;//parseFloat(fee);
        fee *= 1e8;
        fee = Math.floor(fee);
        
        var minWithdraw = fee + 100000;
        assert(typeof userId === 'number');
        if(satoshis < minWithdraw){
          return callback('NOT_ENOUGH_MONEY');
        }
        assert(typeof withdrawalAddress === 'string');
        assert(typeof callback === 'function');

        if(withdrawalAddress === process.env.PUB_KEY){
          return callback('You cannot send to this address. This is the deposit address.');
        }


        // convert amounts to drops
        var amountToSend = parseFloat(parseFloat((satoshis - fee) / 1e8).toFixed(6));
        var drops = parseFloat(parseFloat((satoshis) / 1e8).toFixed(6));

        var payment = {
            "source": {
                "address": process.env.PUB_KEY,
                "maxAmount": {
                    "value": String(drops),
                    "currency": "XRP"
                }
            },
            "destination": {
                "address": withdrawalAddress,
                "amount": {
                    "value": String(amountToSend),
                    "currency": "XRP"
                }
            }
        };

        if(withdrawalTag && withdrawalTag != ""){
          assert(!isNaN(withdrawalTag));
          payment["destination"]["tag"] = parseInt(withdrawalTag);
        }

        console.log("TX TO PREPARE:", JSON.stringify(payment));

        db.prepareWithdraw(userId, satoshis, withdrawalId, (err) => {
          if(err){
            return callback(err);
          }

          api.preparePayment(process.env.PUB_KEY, payment).then(preparedPayment => {
            console.log("PREPARED:", JSON.stringify(preparedPayment));
            var txJSON = preparedPayment.txJSON;
            var signedPayment = api.sign(txJSON, process.env.PRIV_KEY);

            if(satoshis >= 100000000000){ // block at 1k XRP withdraw for review
              console.error("BLOCKED TX, BIG WITHDRAW:", txJSON, signedPayment);
              return db.makeWithdrawal(userId, satoshis, withdrawalAddress, withdrawalId, (err, fundingId) => {
                if (err) {
                  if (err.code === '23514')
                    callback('NOT_ENOUGH_MONEY');
                  else if(err.code === '23505')
                    callback('SAME_WITHDRAWAL_ID');
                  else
                    callback(err);
                  return;
                }

                assert(fundingId);

                callback('FUNDING_QUEUED');
              });
            }else{
              db.verifyUsersWithdrawals(userId, (err, fundingId) => {
                if(err){
                  if(err == "block"){
                    console.error("BLOCKED TX, BIG WITHDRAW:", txJSON, signedPayment);
                    return db.makeWithdrawal(userId, satoshis, withdrawalAddress, withdrawalId, (err, fundingId) => {
                      if (err) {
                        if (err.code === '23514')
                          callback('NOT_ENOUGH_MONEY');
                        else if(err.code === '23505')
                          callback('SAME_WITHDRAWAL_ID');
                        else
                          callback(err);
                        return;
                      }

                      assert(fundingId);

                      callback('FUNDING_QUEUED');
                    });
                  }else{
                    return callback(err);
                  }
                }

                api.submit(signedPayment["signedTransaction"]).then(result => {
                  if(result["resultCode"] != "tesSUCCESS"){
                    if(result["resultCode"] == "terQUEUED"){
                      return db.makeWithdrawal(userId, satoshis, withdrawalAddress, withdrawalId, (err, fundingId) => {
                        if (err) {
                          if (err.code === '23514')
                            callback('NOT_ENOUGH_MONEY');
                          else if(err.code === '23505')
                            callback('SAME_WITHDRAWAL_ID');
                          else
                            callback(err);
                          return;
                        }

                        assert(fundingId);

                        db.setFundingsWithdrawalTxid(fundingId, signedPayment.id, (err) => {
                          if (err)
                            return callback(new Error('Could not set fundingId ' + fundingId + ' to ' + signedPayment.id + ': \n' + err));

                          callback('FUNDING_QUEUED');
                        });
                      });
                    }else{
                      console.error("tx submit error:", result["resultCode"], "("+userId, satoshis, withdrawalAddress, withdrawalId, signedPayment.id+")");
                      return callback("tx submit error: "+ result["resultCode"] +" | withdraw id: '"+withdrawalId+"' | tx id: '"+signedPayment.id+"' | Error message: "+result["resultMessage"]);
                    }
                  }else{
                      db.makeWithdrawal(userId, satoshis, withdrawalAddress, withdrawalId, (err, fundingId) => {
                        if (err) {
                          if (err.code === '23514')
                            callback('NOT_ENOUGH_MONEY');
                          else if(err.code === '23505')
                            callback('SAME_WITHDRAWAL_ID');
                          else
                            callback(err);
                          return;
                        }

                        assert(fundingId);

                        db.setFundingsWithdrawalTxid(fundingId, signedPayment.id, (err) => {
                          if (err)
                            return callback(new Error('Could not set fundingId ' + fundingId + ' to ' + signedPayment.id + ': \n' + err));

                          callback(null);
                        });
                      });
                  }
                }).catch(err => {
                  console.error("tx submit error:", err, "("+userId, satoshis, withdrawalAddress, withdrawalId+")");
                  return callback("An error occured. Withdraw canceled.");
                });
              });
            }
          }).catch(err => {
            console.error("tx prepare error:", err, "("+userId, satoshis, withdrawalAddress, withdrawalId+")");
            return callback("An error occured. Withdraw canceled.");
          });
        });
      });
    }).catch(err => {
      console.error("Withdraw RippleAPI error:", err);
      return callback("An error occured. Withdraw canceled.");
    });
};