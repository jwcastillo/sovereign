import { Template } from 'meteor/templating';
import { ReactiveVar } from 'meteor/reactive-var';
import { Session } from 'meteor/session';

import { Contracts } from '/imports/api/contracts/Contracts';
import { query } from '/lib/views';

import '/imports/ui/templates/components/decision/ballot/ballot.js';
import '/imports/ui/templates/components/decision/poll/poll.html';

Template.poll.onCreated(function () {
  Template.instance().ready = new ReactiveVar(false);
  Template.instance().contracts = new ReactiveVar();
});

Template.poll.onRendered(function () {
  const instance = this;
  const pollId = instance.data.pollId;

  // instance.autorun(function (computation) {
  if (pollId) {
    const options = { view: 'poll', pollId };
    const parameters = query(options);

    const dbQuery = Contracts.find(parameters.find, parameters.options);

    instance.handle = dbQuery.observeChanges({
      addedBefore: (id, fields) => {
        const currentFeed = instance.contracts.get();
        const post = fields;

        post._id = id;

        if (!currentFeed) {
          instance.contracts.set([post]);
        } else {
          currentFeed.push(post);
          instance.contracts.set(_.uniq(currentFeed));
        }
        instance.ready.set(true);
      },
      changed: (id, fields) => {
        const feed = instance.contracts.get();

        for (let i = 0; i < feed.length; i += 1) {
          if (feed[i]._id === id) {
            feed[i] = Object.assign(feed[i], fields);
            break;
          }
        }

        instance.contracts.set(feed);
      },
      removed: () => {
        const feed = instance.contracts.get();

        if (instance.data.editorMode) {
          const draft = Session.get('draftContract');
          for (let i = 0; i < feed.length; i += 1) {
            let isDraftPoll = false;
            for (let k = 0; k < draft.poll.length; k += 1) {
              if (feed[i]._id === draft.poll[k].contractId) {
                isDraftPoll = true;
                break;
              }
            }
            if (!isDraftPoll) {
              feed.splice(i, 1);
              break;
            }
          }
        }

        instance.contracts.set(feed);
      },
    });
  }
  // });
});

Template.poll.helpers({
  ready() {
    return Template.instance().ready.get();
  },
  item() {
    const item = [];
    const contracts = Template.instance().contracts.get();

    for (let i = 0; i < contracts.length; i += 1) {
      item.push({
        contract: contracts[i],
        totals: this.pollTotals,
        editor: this.editorMode,
      });
    }
    return item;
  },
  listItem() {
    return this.list;
  },
  quadratic() {
    return this.quadratic;
  },
  balance() {
    return this.balance;
  },
});
