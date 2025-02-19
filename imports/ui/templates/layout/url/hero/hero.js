import { Template } from 'meteor/templating';
import { Meteor } from 'meteor/meteor';
import { $ } from 'meteor/jquery';
import { Router } from 'meteor/iron:router';
import { TAPi18n } from 'meteor/tap:i18n';
import { ReactiveVar } from 'meteor/reactive-var';
import { Session } from 'meteor/session';

import { timers } from '/lib/const';
import { resetSplit } from '/imports/ui/modules/split';

import { getTemplate } from '/imports/ui/templates/layout/templater';
import { promptLogin } from '/imports/ui/templates/components/collective/collective.js';
import { validateEmail } from '/imports/startup/both/modules/validations.js';

import '/imports/ui/templates/layout/url/hero/hero.html';
import '/imports/ui/templates/widgets/warning/warning.js';
import '/imports/ui/templates/widgets/spinner/spinner.js';

Template.hero.onCreated(function () {
  Template.instance().unclicked = new ReactiveVar(true);
});

Template.hero.onRendered(() => {
  Session.set('invalidHeroEmail', false);
  Session.set('userExists', false);
  Session.set('heroEmailUserCreated', false);
});

Template.hero.helpers({
  title() {
    return TAPi18n.__('landing-title');
  },
  about() {
    return TAPi18n.__('landing-tagline');
  },
  invalidEmail() {
    return Session.get('invalidHeroEmail');
  },
  userExists() {
    return Session.get('userExists');
  },
  heroEmailUserCreated() {
    return Session.get('heroEmailUserCreated');
  },
  unclicked() {
    return Template.instance().unclicked.get();
  },
  callToAction() {
    const skin = Session.get('skin');
    return (skin && skin.header) ? skin.header.callToAction : false;
  },
});

Template.hero.events({
  'click #join'() {
    const email = document.getElementById('lead').value;
    const validEmail = validateEmail(email);
    const instance = Template.instance();

    if (validEmail) {
      instance.unclicked.set(false);
      Meteor.call('createEmailUser', email, (userCreationError) => {
        if (userCreationError) {
          Session.set('userExists', true);
        } else {
          Session.set('heroEmailUserCreated', true);
        }
        instance.unclicked.set(true);
      });
    } else {
      Session.set('invalidHeroEmail', true);
    }
  },
  'focus #lead'() {
    Session.set('invalidHeroEmail', false);
    Session.set('userExists', false);
    Session.set('heroEmailUserCreated', false);
  },
});


const _prompt = (instance) => {
  const buttonMode = !instance.activeSignIn.get();
  instance.activeSignIn.set(buttonMode);
  promptLogin(buttonMode, event);
};

const heroMode = (instance) => {
  const node = $('.hero-navbar');
  const st = $('.right').scrollTop();
  if (instance.activeSignIn.get()) {
    _prompt(instance);
  }
  let heroHeight;

  if (instance.data.postMode) {
    heroHeight = 0;
    node.removeClass('hero-navbar-scroller');
    $('.hero').css('position', 'fixed');
    $('.hero').css('z-index', '1');
  } else {
    heroHeight = 400;
    if (st > heroHeight) {
      node.addClass('hero-navbar-scroller');
      if (node.css('position') !== 'fixed') {
        node.css('position', 'fixed');
        node.css('top', '-100px');
        node.css('opacity', '1');
        node.css('height', '65px');
        node.velocity('stop');
        node.velocity({ top: '0px' }, { duration: parseInt(timers.ANIMATION_DURATION, 10), easing: 'ease-out' });
      }
    } else if (st < heroHeight) {
      node.velocity('stop');
      node.velocity({ top: '-100px' }, {
        duration: parseInt(timers.ANIMATION_DURATION, 10),
        easing: 'ease-out',
        complete: () => {
          node.removeClass('hero-navbar-scroller');
          node.css('position', 'absolute');
          node.css('opacity', 0);
          node.css('top', '0px');
          node.velocity({ opacity: 1 }, { duration: parseInt(timers.ANIMATION_DURATION * 2, 10), easing: 'ease-out' });
        },
      });
    }
  }
};

const scrollingMenu = (instance) => {
  $('.right').scroll(() => {
    heroMode(instance);
  });
};

Template.navbar.onCreated(function () {
  Template.instance().activeSignIn = new ReactiveVar(false);
});


Template.navbar.onRendered(function () {
  const instance = Template.instance();

  if (!instance.data.postMode) {
    scrollingMenu(instance);
  } else {
    $('.right').off('scroll');
    heroMode(instance);
  }

  if (!Meteor.Device.isPhone() && !Meteor.user()) {
    resetSplit();
  } else if (Meteor.Device.isPhone() && !Meteor.user() && !instance.data.postMode) {
    $('.split-left').css('padding-top', '0px');
  }

  if (Meteor.Device.isPhone()) {
    window.addEventListener('click', function (e) {
      if (document.getElementById('user-login') && document.getElementById('user-login').contains(e.target)) {
        instance.activeSignIn.set(false);
      }
    });
  }
});

Template.navbar.helpers({
  logoExtended() {
    return Meteor.settings.public.Collective.profile.logoExtended;
  },
  picture() {
    if (Meteor.settings.public.Collective.profile.logo) {
      return Meteor.settings.public.Collective.profile.logo;
    }
    return 'images/earth.png';
  },
  loginMode() {
    if (Session.get('userLoginVisible')) {
      return 'hero-menu-link-signin-active';
    }
    Template.instance().activeSignIn.set(false);
    return '';
  },
  homeURL() {
    return Meteor.settings.public.Collective.domain;
  },
  navbarItem() {
    return Meteor.settings.public.app.config.navbar;
  },
  postMode() {
    return Template.instance().postMode;
  },
});

Template.navbar.events({
  'click #collective-login'() {
    event.stopPropagation();
    _prompt(Template.instance());
  },
  'click #nav-home'(event) {
    event.preventDefault();
    event.stopPropagation();
    Router.go('/');
  },
});

const _template = async (instance) => {
  const html = await getTemplate().then((resolved) => { instance.skin.set(resolved); Session.set('skin', resolved); });
  return html;
};

Template.demo.onCreated(function () {
  Template.instance().skin = new ReactiveVar();
  _template(Template.instance());
});

Template.demo.helpers({
  renderTemplate() {
    const skin = Template.instance().skin.get();
    return (skin && skin.header.html) ? skin.header.html : '';
  },
});
