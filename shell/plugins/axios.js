import https from 'https';
import { CSRF } from '@shell/config/cookies';
import { parse as setCookieParser } from 'set-cookie-parser';
import pkg from '../package.json';
import { config } from 'process';

export default function({
  $axios, $cookies, isDev, req
}) {
  $axios.defaults.headers.common['Accept'] = 'application/json';
  $axios.defaults.withCredentials = true;

  $axios.onRequest((config) => {
    const csrf = $cookies.get(CSRF, { parseJSON: false });

    if ( csrf ) {
      config.headers['x-api-csrf'] = csrf;
    }

    if ( config.url.startsWith('/') && !config.url.startsWith('/api/kube')) {
      config.baseURL = `${ getBasePath() }`;
      config.url = '/api/kube/rancher' + config.url
    }

    if ( process.server ) {
      config.headers.common['access-control-expose-headers'] = `set-cookie`;
      config.headers.common['user-agent'] = `Dashboard (Mozilla) v${ pkg.version }`;

      if ( req.headers.cookie ) {
        config.headers.common['cookies'] = req.headers.cookie;
      }

      if ( config.url.startsWith('/') ) {
        config.baseURL = `${ req.protocol || 'https' }://${ req.headers.host }`;
      }
    }

    let url = config.url
    if (url.startsWith('http')) {
      const purl = new URL(url)

      if (!purl.pathname.startsWith('/api/kube')) {
        purl.pathname = `/api/kube/rancher${purl.pathname}`
      }
      url = purl.toString()
    }

    config.url = url
  });


  if ( process.server ) {
    $axios.onResponse((res) => {
      const parsed = setCookieParser(res.headers['set-cookie'] || []);

      for ( const opt of parsed ) {
        const key = opt.name;
        const value = opt.value;

        delete opt.name;
        delete opt.value;

        opt.encode = (x) => x;
        opt.sameSite = true;
        opt.path = '/';
        opt.secure = true;

        $cookies.set(key, value, opt);
      }
    });
  }

  if ( isDev ) {
    // https://github.com/nuxt-community/axios-module/blob/dev/lib/module.js#L78
    // forces localhost to http, for no obvious reason.
    // But we never have any reason to talk to anything plaintext.
    if ( $axios.defaults.baseURL.startsWith('http://') ) {
      $axios.defaults.baseURL = $axios.defaults.baseURL.replace(/^http:/, 'https:');
    }

    const insecureAgent = new https.Agent({ rejectUnauthorized: false });

    $axios.defaults.httpsAgent = insecureAgent;
    $axios.httpsAgent = insecureAgent;
  }
}

function getBasePath() {
  if (window.__basePath__) {
    return window.__basePath__;
  }
  const baseUrl = document.querySelector('head > base').href;
  const basePath = `${ baseUrl.slice(0, -('/kubeui/'.length - 1)).replace(window.location.origin, '') }`;

  window.__basePath__ = basePath;

  return window.__basePath__;
}
