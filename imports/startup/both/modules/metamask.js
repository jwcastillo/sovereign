import { Meteor } from 'meteor/meteor';
import { Accounts } from 'meteor/accounts-base';
import { TAPi18n } from 'meteor/tap:i18n';
import { Router } from 'meteor/iron:router';
import { Session } from 'meteor/session';
import { $ } from 'meteor/jquery';

import { Contracts } from '/imports/api/contracts/Contracts';
import { displayModal } from '/imports/ui/modules/modal';
import { transact } from '/imports/api/transactions/transaction';
import { displayNotice } from '/imports/ui/modules/notice';
import { addDecimal, smallNumber, removeDecimal, getCoin, numToCryptoBalance } from '/imports/api/blockchain/modules/web3Util';
import { animatePopup } from '/imports/ui/modules/popup';
import { Transactions } from '/imports/api/transactions/Transactions';

import { BigNumber } from 'bignumber.js';

import abi from 'human-standard-token-abi';
import { debug } from 'util';

const Web3 = require('web3');
const ethUtil = require('ethereumjs-util');
const abiDecoder = require('abi-decoder');
const numeral = require('numeral');

let web3;

const modal = {
  icon: Meteor.settings.public.Collective.profile.logo,
  title: TAPi18n.__('wallet'),
  cancel: TAPi18n.__('close'),
  alertMode: true,
};

/**
* @summary given a token code, returns unit of conversion for web3 prompt
* @param {string} ticker token ticker
*/
const _convertToEther = (ticker) => {
  switch (ticker) {
    case 'ETH':
    case 'WEI':
    default:
      return 'ether';
  }
};

/**
* @summary format currency display according to crypto rules
* @param {string} value value to be changed
* @param {string} tokenCode currency being used
* @returns {string} formatted number
*/
const _formatCryptoValue = (value, tokenCode) => {
  let tokenFinal;
  if (!tokenCode) { tokenFinal = 'ETH'; } else { tokenFinal = tokenCode; }
  return numeral(value, tokenFinal).format(getCoin(tokenFinal).format);
};

/**
* @summary check web3 plugin and connects to code obejct
*/
const _web3 = (activateModal) => {
  if (!window.web3) {
    if (activateModal) {
      modal.message = TAPi18n.__('metamask-install');
      displayModal(true, modal);
    }
    return false;
  }
  if (!web3) {
    web3 = new Web3(window.web3.currentProvider);
  }

  web3.eth.getCoinbase().then(function (coinbase) {
    if (!coinbase) {
      if (activateModal) {
        modal.message = TAPi18n.__('metamask-activate');
        displayModal(true, modal);
        return false;
      }
    }
  });

  return web3;
};

/**
* @summary get the current status of an on chain transaction
* @param {string} hash of the ticket
*/
const _getTransactionStatus = (hash) => {
  if (_web3(true)) {
    return web3.eth.getTransactionReceipt(hash, (err, res) => {
      if (!err) {
        return res;
      }
      return false;
    });
  }
  return false;
};

/**
* @summary hide login forms
*/
const _hideLogin = () => {
  $('.right').scrollTop(0);
  Session.set('userLoginVisible', false);
  animatePopup(false, 'user-login');
};

/**
* @summary syncs app with blockchain data
* @param {object} contract to verify if still pending
*/
const _syncBlockchain = (contract) => {
  if (contract && contract.blockchain && contract.blockchain.tickets.length > 0) {
    const blockchain = contract.blockchain;
    const contractId = contract._id;
    if (contract.blockchain.tickets[0].status === 'PENDING') {
      _getTransactionStatus(contract.blockchain.tickets[0].hash).then(
        function (receipt) {
          if (receipt) {
            if (receipt.status) {
              blockchain.tickets[0].status = 'CONFIRMED';
              // reload user balance on confirmed transaction
              Meteor.call('loadUserTokenBalance', Meteor.userId(), (loadBalanceError) => {
                if (loadBalanceError) {
                  console.log(loadBalanceError, 'error reloading user balance after Metamask transaction');
                }
              });
            } else {
              blockchain.tickets[0].status = 'FAIL';
            }
            Transactions.update({ _id: contractId }, { $set: { 'blockchain.tickets': blockchain.tickets } });

            Meteor.call('updateTransactionStatus', contract.blockchain.tickets[0].hash, blockchain.tickets[0].status, (error) => {
              if (error) {
                console.log(error, 'error updating transactions with this hash on server.');
              }
            });
          }
        }
      );
    }
  }
};


/**
* @summary writes delegation on user array
* @param {object} user the user getting written
* @param {object} delegation the delegation
* @return {object} user.profile.delegetaions
*/
const _writeDelegation = (user, delegation) => {
  if (!user.profile.delegations || user.profile.delegations.length === 0) {
    user.profile.delegations = [delegation];
  } else {
    let found = false;
    for (let i = 0; i < user.profile.delegations.length; i += 1) {
      if (user.profile.delegations[i].userId === delegation.userId) {
        if (user.profile.delegations[i].policies.length === 0) {
          user.profile.delegations[i].policies = delegation.policies;
        } else {
          user.profile.delegations[i].policies.push(delegation.policies[0]);
        }
        if (user.profile.delegations[i].tickets.length === 0) {
          user.profile.delegations[i].tickets = delegation.tickets;
        } else {
          user.profile.delegations[i].tickets.push(delegation.tickets[0]);
        }
      }
    }
    if (!found) {
      user.profile.delegations.push(delegation);
    }
  }
  return user.profile.delegations;
}


/**
* @summary new model for delegations version 1.0 beta
* @param {string} sourceId who is delegating
* @param {string} targetId to whom
* @param {string} contractId why
* @param {object} receipt blockchain ticket
*/
const _delegate = (sourceId, targetId, contractId, hash, value) => {
  if (sourceId !== targetId) {
    // update source
    const source = Meteor.users.findOne({ _id: sourceId });
    source.profile.delegations = _writeDelegation(source, {
      userId: targetId,
      policies: [{
        contractId,
        incoming: false,
      }],
      tickets: [{
        hash,
        status: 'PENDING',
        value,
      }],
    });
    Meteor.users.update({ _id: sourceId }, { $set: { profile: source.profile }});

    // update target
    const target = Meteor.users.findOne({ _id: targetId });
    target.profile.delegations = _writeDelegation(target, {
      userId: sourceId,
      policies: [{
        contractId,
        incoming: true,
      }],
      tickets: [{
        hash,
        status: 'PENDING',
        value,
      }],
    });

    Meteor.users.update({ _id: targetId }, { $set: { profile: target.profile }});
  }
};

/**
* @summary send crypto with mask;
* @param {string} from blockchain address
* @param {string} to blockchain destination
* @param {string} quantity amount transacted
* @param {string} tokenCode currency
* @param {string} contractAddress
* @param {string} sourceId sender in sovereign
* @param {string} targetId receiver in sovereign
* @param {string} delegateId user to delegate into
*/
const _transactWithMetamask = (from, to, quantity, tokenCode, contractAddress, sourceId, targetId, delegateId) => {
  if (_web3(true)) {
    const coin = getCoin(tokenCode);
    const html = `<span class="suggest-item suggest-token suggest-token-inline" style="background-color: ${coin.color} ">${coin.code}</span>`;

    if (quantity === undefined) {
      quantity = 1;
    }

    let tx;
    const contract = new web3.eth.Contract(abi, contractAddress);
    if (tokenCode === 'ETH') {
      tx = {
        from,
        to,
        value: web3.utils.toHex(web3.utils.toWei(quantity, _convertToEther(tokenCode))),
        gas: 200000,
        chainId: 3, // should this be 4 for rinkeby too?
      };
    } else {
      let quantityWithDecimals;
      if (coin.nonFungible) {
        quantityWithDecimals = new BigNumber(quantity.toNumber());
      } else {
        quantityWithDecimals = addDecimal(quantity.toNumber(), coin.decimals);
      }
      
      tx = {
        from,
        to: contractAddress,
        value: 0,
        data: contract.methods.transfer(to, quantityWithDecimals).encodeABI(),
        gas: 200000,
        chainId: 4,
      };
    }
    web3.eth.sendTransaction(tx, (error, receipt) => {
      web3.eth.getTransaction(receipt, (err, res) => {
        let value = '0';

        if (res.input === '0x') {
          // ethereum transaciton
          value = res.value;
        } else {
          // token transaction
          abiDecoder.addABI(abi);
          const data = abiDecoder.decodeMethod(res.input);

          // get data from smart contract input
          if (data.name === 'transfer') {
            for (let i = 0; i < data.params.length; i += 1) {
              if (data.params[i].name === '_value') {
                value = data.params[i].value;
                break;
              }
            }
          }
        }

        // persist transaction in sovereign
        if (!err) {
          transact(
            sourceId,
            targetId,
            0,
            {
              currency: tokenCode,
              status: 'PENDING',
              kind: 'CRYPTO',
              contractId: targetId,
              input: {
                address: res.from,
              },
              output: {
                address: res.to,
              },
              blockchain: {
                tickets: [{
                  hash: res.hash,
                  status: 'PENDING',
                  value,
                }],
                coin: {
                  code: tokenCode,
                },
              },
              geo: Meteor.user().profile.country ? Meteor.user().profile.country.code : '',
            },
            () => {
              _delegate(Meteor.userId(), delegateId, targetId, res.hash, value);
              displayModal(false, modal);
              displayNotice(`${TAPi18n.__('transaction-broadcast').replace('{{token}}', html)}`, true, true);
            }
          );
        }
      });
    }).catch(function (e) {
      if (e.message === 'Returned error: Error: MetaMask Tx Signature: User denied transaction signature.') {
        modal.message = TAPi18n.__('metamask-denied-signature');
        displayModal(true, modal);
      } else if (e.message.substring(0, 65) === 'Returned error: Error: WalletMiddleware - Invalid "from" address.') {
        modal.message = TAPi18n.__('metamask-invalid-address');
        displayModal(true, modal);
      } else {
        displayNotice(`${TAPi18n.__('transaction-broadcast-error').replace('{{token}}', html)}`, true, true);
      }
    });
  } else {
    Meteor.logout();
    return undefined;
  }
};


const handleSignMessage = (publicAddress, nonce, message) => {
  return new Promise((resolve, reject) => {
    web3.eth.personal.sign(
      web3.utils.utf8ToHex(`${message}`),
      publicAddress,
      function (err, signature) {
        if (err) return reject(err);
        return resolve({ signature });
      }
    );
  });
};

const verifySignature = (signature, publicAddress, nonce, message) => {
  let msg;
  console.log(message);
  if (!message) {
    msg = `${TAPi18n.__('metamask-sign-nonce').replace('{{collectiveName}}', Meteor.settings.public.Collective.name)}`;
  } else {
    msg = message;
  }
  let res;

  // Perform an elliptic curve signature verification with ecrecover
  const msgBuffer = ethUtil.toBuffer(msg);
  const msgHash = ethUtil.hashPersonalMessage(msgBuffer);
  const signatureBuffer = ethUtil.toBuffer(signature.signature);
  const signatureParams = ethUtil.fromRpcSig(signatureBuffer);
  const publicKey = ethUtil.ecrecover(
    msgHash,
    signatureParams.v,
    signatureParams.r,
    signatureParams.s
  );
  const addressBuffer = ethUtil.publicToAddress(publicKey);
  const address = ethUtil.bufferToHex(addressBuffer);

  // The signature verification is successful if the address found with
  // ecrecover matches the initial publicAddress

  if (address.toLowerCase() === publicAddress.toLowerCase()) {
    return 'success';
  }
  return res
    .status(401)
    .send({ error: TAPi18n.__('metamask-sign-fail') });
};

/**
* @summary persist in db the coin vote
* @param {string} from blockchain address
* @param {string} to blockchain destination
* @param {string} tokenCode currency
* @param {string} value the value
* @param {string} sourceId sender in sovereign
* @param {string} targetId receiver in sovereign
* @param {string} delegateId user to delegate into
*/
const _transactCoinVote = (sourceId, targetId, tokenCode, from, to, value, delegateId, publicAddress) => {
  transact(
    sourceId,
    targetId,
    0,
    {
      currency: tokenCode,
      status: 'PENDING',
      kind: 'CRYPTO',
      contractId: targetId,
      input: {
        address: from,
      },
      output: {
        address: to,
      },
      blockchain: {
        tickets: [{
          hash: publicAddress,
          status: 'CONFIRMED',
          value,
        }],
        coin: {
          code: tokenCode,
        },
      },
      geo: Meteor.user().profile.country ? Meteor.user().profile.country.code : '',
    },
    () => {
      _delegate(Meteor.userId(), delegateId, targetId, publicAddress, value);
      displayModal(false, modal);
      displayNotice(`${TAPi18n.__('transaction-tally').replace('{{token}}', tokenCode)}`, true, true);
    }
  );
};

/**
* @summary do a coinvote with account stake
* @param {string} from blockchain address
* @param {string} to blockchain destination
* @param {string} quantity amount transacted
* @param {string} tokenCode currency
* @param {string} contractAddress
* @param {string} sourceId sender in sovereign
* @param {string} targetId receiver in sovereign
* @param {string} delegateId user to delegate into
*/
const _coinvote = (from, to, quantity, tokenCode, contractAddress, sourceId, targetId, delegateId, choice, url) => {
  if (_web3(true)) {
    const nonce = Math.floor(Math.random() * 10000);
    const coin = getCoin(tokenCode);
    let publicAddress;

    let message = TAPi18n.__('coinvote-signature');

    message = message.replace('{{quantity}}', coin.code === 'ETH' ? quantity : _formatCryptoValue(quantity, coin.code));
    message = message.replace('{{ticker}}', tokenCode);
    message = message.replace('{{choice}}', choice);
    message = message.replace('{{url}}', url);

    let value;
    if (tokenCode === 'ETH') {
      value = web3.utils.toWei(quantity, _convertToEther(tokenCode)).toString();
    } else {
      const quantityWithDecimals = numToCryptoBalance(quantity, coin.code); // addDecimal(quantity.toNumber(), coin.decimals).toString();
      value = quantityWithDecimals;
    }

    if (Meteor.Device.isPhone()) {
      return web3.eth.getCoinbase().then(function (coinbaseAddress) {
        publicAddress = coinbaseAddress.toLowerCase();
        return handleSignMessage(publicAddress, nonce, message);
      }).then(function (signature) {
        const verification = verifySignature(signature, publicAddress, nonce, message);

        if (verification === 'success') {
          _transactCoinVote(sourceId, targetId, tokenCode, from, to, value, delegateId, publicAddress);
        } else {
          console.log(TAPi18n.__('metamask-login-error'));
        }
      });
    }

    // Support privacy-mode in desktop only for now
    window.ethereum.enable().then(function () {
      return web3.eth.getCoinbase();
    }).then(function (coinbaseAddress) {
      publicAddress = coinbaseAddress.toLowerCase();
      return handleSignMessage(publicAddress, nonce, message);
    }).then(function (signature) {
      const verification = verifySignature(signature, publicAddress, nonce, message);

      if (verification === 'success') {
        _transactCoinVote(sourceId, targetId, tokenCode, from, to, value, delegateId, publicAddress);
      } else {
        console.log(TAPi18n.__('metamask-login-error'));
      }
    })
      .catch((e) => {
        displayModal(false, modal);
        displayNotice(`${TAPi18n.__('transaction-tally-denied').replace('{{token}}', tokenCode)}`, true, true);
      });
  } else {
    modal.message = TAPi18n.__('metamask-activate');
    displayModal(true, modal);
  }
};

const _scanCoinVote = (contract) => {
  if (Meteor.user()) {
    if (contract.blockchain && contract.blockchain.tickets) {
      for (let i = 0; i < contract.blockchain.tickets.length; i += 1) {
        for (let k = 0; k < Meteor.user().profile.wallet.reserves.length; k += 1) {
          if (contract.blockchain.tickets[i].hash === Meteor.user().profile.wallet.reserves[k].publicAddress) {
            return true;
          }
        }
      }
    }
  }
  return false;
};

/**
* @summary checks if user didn't coinvoted already
* @param {object} contract with the settings
* @return {boolean} if voted already or not
*/
const _verifyCoinVote = (contract) => {
  let poll;
  let check;
  if (contract.rules && contract.rules.balanceVoting) {
    if (contract.poll && contract.poll.length > 0) {
      for (let i = 0; i < contract.poll.length; i += 1) {
        poll = Contracts.findOne({ _id: contract.poll[i].contractId });
        if (poll) {
          check = _scanCoinVote(poll);
          if (check) { break; }
        }
      }
      return check;
    }
    return _scanCoinVote(contract);
  }
  return false;
};


/**
* @summary get current height of the blockchain
*/
const _getBlockHeight = async () => {
  let height = 0;
  if (_web3()) {
    height = await web3.eth.isSyncing().then(
      async (res) => {
        if (!res) {
          return await web3.eth.getBlockNumber().then((blockNumber) => {
            return blockNumber;
          });
        }
        return false;
      }
    );
  }
  return height;
};


if (Meteor.isClient) {
  /**
  * @summary log in signing public blockchain address with private key
  */
  const loginWithMetamask = () => {
    if (_web3(false)) {
      const nonce = Math.floor(Math.random() * 10000);
      let publicAddress;

      if (Meteor.Device.isPhone()) {
        // When mobile, not supporting privacy-mode for now
        // https://github.com/DemocracyEarth/sovereign/issues/421
        return web3.eth.getCoinbase().then(function (coinbaseAddress) {
          publicAddress = coinbaseAddress.toLowerCase();
          return handleSignMessage(publicAddress, nonce, TAPi18n.__('metamask-sign-nonce').replace('{{collectiveName}}', Meteor.settings.public.Collective.name));
        }).then(function (signature) {
          const verification = verifySignature(signature, publicAddress, nonce);

          if (verification === 'success') {
            const methodName = 'login';
            const methodArguments = [{ publicAddress }];
            Accounts.callLoginMethod({
              methodArguments,
              userCallback: (err) => {
                Accounts._pageLoadLogin({
                  type: 'metamask',
                  allowed: !err,
                  error: err,
                  methodName,
                  methodArguments,
                });
                Session.set('newLogin', true);
                Router.go('/');
              },
            });
          } else {
            console.log(TAPi18n.__('metamask-login-error'));
          }
        });
      }

      // Support privacy-mode in desktop only for now
      window.ethereum.enable().then(function () {
        return web3.eth.getCoinbase();
      }).then(function (coinbaseAddress) {
        publicAddress = coinbaseAddress.toLowerCase();
        return handleSignMessage(publicAddress, nonce, TAPi18n.__('metamask-sign-nonce').replace('{{collectiveName}}', Meteor.settings.public.Collective.name));
      }).then(function (signature) {
        const verification = verifySignature(signature, publicAddress, nonce);

        if (verification === 'success') {
          const methodName = 'login';
          const methodArguments = [{ publicAddress }];
          Accounts.callLoginMethod({
            methodArguments,
            userCallback: (err) => {
              Accounts._pageLoadLogin({
                type: 'metamask',
                allowed: !err,
                error: err,
                methodName,
                methodArguments,
              });
              Router.go('/');
              _hideLogin();
            },
          });
        } else {
          console.log(TAPi18n.__('metamask-login-error'));
        }
      });
    } else {
      modal.message = TAPi18n.__('metamask-activate');
      displayModal(true, modal);
    }
  };

  Accounts.registerClientLoginFunction('metamask', loginWithMetamask);

  Meteor.loginWithMetamask = function () {
    return Accounts.callLoginFunction('metamask');
  };
}

if (Meteor.isServer) {
  Accounts.registerLoginHandler('metamask', function (opts) {
    if (opts.publicAddress) {
      const publicAddress = opts.publicAddress;
      let user = null;
      const userQuery = Meteor.users.find({ username: publicAddress }).fetch();
      let serviceUserId = {};

      // Check if user with current publicAddress already exists
      if (userQuery.length === 0) {
        // If not, create it
        user = Accounts.updateOrCreateUserFromExternalService('metamask', {
          id: publicAddress,
          publicAddress,
        });
        serviceUserId = { userId: user.userId };
      } else {
        // Otherwise, retrieve it
        user = userQuery;
        serviceUserId = { userId: user[0]._id };
      }
      return serviceUserId;
    }
  });

  // TODO— time to move this boy to accounts.js
  Accounts.onLogin(function (loginObject) {
    if (loginObject.type !== 'resume') {
      Meteor.call('loadUserTokenBalance', loginObject.user._id, (subsidyError) => {
        if (subsidyError) {
          console.log(subsidyError, 'error on Accounts.onLogin');
        }
      });
    }
  });
}

export const transactWithMetamask = _transactWithMetamask;
export const coinvote = _coinvote;
export const getTransactionStatus = _getTransactionStatus;
export const setupWeb3 = _web3;
export const syncBlockchain = _syncBlockchain;
export const hideLogin = _hideLogin;
export const getBlockHeight = _getBlockHeight;
export const verifyCoinVote = _verifyCoinVote;
