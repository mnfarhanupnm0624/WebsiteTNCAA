/**
 * Copyright 2017 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

importScripts(`${_wordpressConfig.templateUrl}/scripts/transformstream.js`);
importScripts(`${_wordpressConfig.templateUrl}/scripts/idb.js`);
importScripts(`${_wordpressConfig.templateUrl}/scripts/pubsubhub.js`);
importScripts(`${_wordpressConfig.templateUrl}/scripts/bg-sync-manager.js`);
importScripts(`${_wordpressConfig.templateUrl}/scripts/analytics-sw.js`);

const VERSION = '{%VERSION%}';

self.oninstall = event => {
  event.waitUntil(async function() {
    const cache = await caches.open('pwp');
    await cache.addAll([
      `${_wordpressConfig.templateUrl}/header.php?fragment=true`,
      `${_wordpressConfig.templateUrl}/?fragment=true`,
      `${_wordpressConfig.templateUrl}/footer.php?fragment=true`,
      `${_wordpressConfig.templateUrl}/lazy.css`,
      `${_wordpressConfig.templateUrl}/scripts/import-polyfill.js`,
      `${_wordpressConfig.templateUrl}/scripts/analytics.js`,
      `${_wordpressConfig.templateUrl}/scripts/ric-polyfill.js`,
      `${_wordpressConfig.templateUrl}/scripts/pubsubhub.js`,
      `${_wordpressConfig.templateUrl}/scripts/router.js`,
      `${_wordpressConfig.templateUrl}/scripts/pwp-view.js`,
      `${_wordpressConfig.templateUrl}/scripts/pwp-spinner.js`,
      `${_wordpressConfig.templateUrl}/components/fonts.css`,
      `${_wordpressConfig.templateUrl}/fonts/Catamaran-Black.woff`,
      `${_wordpressConfig.templateUrl}/fonts/Catamaran-Bold.woff`,
      `${_wordpressConfig.templateUrl}/fonts/Catamaran-Medium.woff`,
      `${_wordpressConfig.templateUrl}/fonts/Catamaran-Light.woff`,
    ]
      .map(url => new Request(url, {credentials: "include"})));

    await Promise.all([
      'https://www.google-analytics.com/analytics.js',
    ]
      .map(url => new Request(url, {mode: 'no-cors'}))
      .map(async req => await cache.put(req, await fetch(req)))
    );
    // TODO Need to broadcast changes here
    return self.skipWaiting();
  }());
};

self.onactivate = event => {
  event.waitUntil(self.clients.claim());
}

self.onfetch = event => {
  if(isAnalyticsRequest(event))
    return analytics(event);
  if(isCommentRequest(event)) return postComment(event);
  if(isCustomizerRequest(event) || isWpRequest(event))
    return; // A return passes handling to the network
  if(isFragmentRequest(event) || isAssetRequest(event) || isPluginRequest(event) || isCrossOriginRequest(event))
    return event.respondWith(staleWhileRevalidate(event.request, event));

  const newRequestURL = new URL(event.request.url);
  newRequestURL.searchParams.append('fragment', 'true');
  newRequestURL.searchParams.delete('loadimages');

  const responsePromises = [
    `${_wordpressConfig.templateUrl}/header.php?fragment=true`,
    newRequestURL,
    `${_wordpressConfig.templateUrl}/footer.php?fragment=true`,
  ].map(u => staleWhileRevalidate(new Request(u), event));

  const {readable, writable} = new TransformStream();
  event.waitUntil(async function() {
    if(needsSmallHeader(event)) {
      responsePromises[0] = async function() {
        // TODO: Super dirty. Should be a trasform stream, really.
        const resp = await responsePromises[0];
        const body = await resp.text();
        return new Response(body.replace('class="hero', 'class="hero single'));
      }();
    }
    for (const responsePromise of responsePromises) {
      const response = await responsePromise;
      await response.body.pipeTo(writable, {preventClose: true});
    }
    writable.getWriter().close();
  }());
  event.respondWith(new Response(readable));
};

self.onsync = event => {
  switch(event.tag) {
    case 'test-tag-from-devtools':
    case 'comment-sync':
    case 'ga-sync':
      _bgSyncManager.process(event);
    break;
    default:
      console.error(`Unknown background sync: ${event.tag}`);
  }
}

function needsSmallHeader(event) {
  return new URL(event.request.url).pathname !== '/';
}

function isCrossOriginRequest(event) {
  return new URL(event.request.url).hostname !== new URL(_wordpressConfig.templateUrl).hostname;
}

function isFragmentRequest(event) {
  return new URL(event.request.url).searchParams.get('fragment') === 'true';
}

function isAssetRequest(event) {
  return /(jpe?g|png|css|svg|js|woff)$/i.test(event.request.url)
    || event.request.url.endsWith('manifest.php');
}

function isPluginRequest(event) {
  return new URL(event.request.url).pathname.startsWith('/wp-content/plugins');
}

function isWpRequest(event) {
  const parsedUrl = new URL(event.request.url);
  return parsedUrl.pathname.startsWith('/wp-') && !parsedUrl.pathname.startsWith('/wp-content');
}

function isCustomizerRequest(event) {
  return new URL(event.request.url).searchParams.has('customize_changeset_uuid');
}

function isCommentRequest(event) {
  return event.request.method === 'POST' &&
    new URL(event.request.url).pathname === '/wp-comments-post.php';
}

async function staleWhileRevalidate(request, event) {
  const networkResponsePromise = fetch(request, {credentials: "include"}).catch(_ => {});
  const cacheResponsePromise = caches.match(request);

  // Update cache
  event.waitUntil(async function () {
    const cacheName = await extractCacheName(request.url, event);
    const cache = await caches.open(cacheName);
    const networkResponse = await networkResponsePromise;
    const cacheResponse = await cacheResponsePromise;
    if(networkResponse && cacheResponse) {
      const changed = networkResponse.headers.get('Etag') !== cacheResponse.headers.get('Etag');
      if(changed) await _pubsubhub.dispatch('resource_update', {name: request.url});
    }
    if(networkResponse) {
       cache.put(request, networkResponse.clone());
    }
  }());

  // Determine response
  const cacheResponse = await cacheResponsePromise;
  if (cacheResponse) return cacheResponse.clone();
  const networkResponse = await networkResponsePromise;
  if(networkResponse) return networkResponse.clone();
  throw new Error(`Neither network nor cache had a response for ${request.url}`);
}

async function extractCacheName(url, event) {
  if(url.startsWith(_wordpressConfig.templateUrl))
    return 'pwp';

  const client = await self.clients.get(event.clientId);
  if(client) {
    url = client.url;
  }
  return `pwp_pathid_${new URL(url).pathname.split('/').filter(s => !!s).join('_')}`;
}

function postComment(event) {
  if(!_bgSyncManager.supportsBackgroundSync) return;

  event.waitUntil(async function() {
    const referrer = new URL(event.request.referrer);
    event.respondWith(new Response(null, {status: 302, headers: {"Location": referrer.pathname}}));
    await _bgSyncManager.enqueue(event.request);
    await _bgSyncManager.trigger();
  }());
}
