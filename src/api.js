'use strict';
const express = require('express');
const serverless = require('serverless-http');
const axios = require('axios');
const m3u8 = require('m3u8-parser');
require('dotenv').config();

const { PROXY_HOST, PROXY_PORT } = process.env;

const parser = new m3u8.Parser();

parser.addParser({
  expression: /^#EXT-X-TWITCH-INFO/,
  customType: 'twitchInfo',
  dataParser: (line) => {
    return line
      .split(':')
      .slice(1)
      .join('')
      .split(',')
      .reduce((acc, curr) => {
        const components = curr.split('=');
        acc[components[0]] = components[1].slice(1, -1);
        return acc;
      }, {});
  },
});

const app = express();
const router = express.Router();

function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  const { channel, vodId } = req.params;
  const baseURL = 'usher.ttvnw.net';
  const path = req.originalUrl;
  const playlist = path.substring(path.lastIndexOf('/') + 1);
  const useProxies = true;
  const isVOD = !!vodId;
  console.log(`Fetching ${isVOD ? `VOD (${vodId})` : `playlist (${channel})`}`);
  axios
    .get(`https://${baseURL}${path}`)
    .then(({ status, data, request }) => {
      if (status != 200)
        throw new Error(`${request.host} returned status code ${status}`);
      console.log(`${request.host} success`);
      parser.push(data);
      parser.end();
      res.setHeader('Content-Length', Buffer.byteLength(data, 'utf8'));
      const suppress = parser.manifest.custom.twitchInfo.SUPPRESS === 'true';
      // Not sure if this flag is available for VODs, for now we'll just use the proxy anyways
      if (useProxies && (isVOD || suppress)) {
        const proxies = [
          !(PROXY_HOST && PROXY_PORT) || {
            url: `https://${baseURL}${path}`,
            proxy: {
              host: PROXY_HOST,
              port: PROXY_PORT,
            },
          },
          {
            url: `https://api.ttv.lol/${
              isVOD ? 'vod' : 'playlist'
            }/${encodeURIComponent(playlist)}`,
            headers: {
              'X-Donate-To': 'https://ttv.lol/donate',
            },
          },
          isVOD || {
            url: `https://jupter.ga/channel/${channel}`,
          },
        ]
          .filter((_) => _.url)
          .map(({ url, proxy, headers }) => {
            return axios
              .get(url, { proxy, headers, timeout: 5000 })
              .then(({ status, data, request }) => {
                if (status != 200)
                  throw new Error(
                    `${request.host} returned status code ${status}`
                  );
                if (!data.startsWith('#EXTM3U'))
                  throw new Error(`${request.host} returned invalid playlist`);
                console.log(`${request.host} success`);
                return data;
              });
          });

        Promise.any(proxies)
          .then((data) => {
            res.setHeader('Content-Length', Buffer.byteLength(data, 'utf8'));
            res.status(200).send(data).end();
          })
          .catch((error) => {
            console.log(error.message);
            if (error instanceof AggregateError)
              error.errors.forEach((error) => console.log(error.message));
            res.status(200).send(data).end();
          });
      } else {
        res.status(200).send(data).end();
      }
    })
    .catch((error) => {
      console.log(`${baseURL} ${error.message}`);
      res.status(404).end();
    });
}

router.get('/vod/:vodId.m3u8', handleRequest);

router.get('/api/channel/hls/:channel.m3u8', handleRequest);

app.use(router);

module.exports = app;
module.exports.handler = serverless(app, { provider: 'aws' });
