'use strict';
const express = require('express');
const serverless = require('serverless-http');
const axios = require('axios');
const m3u8 = require('m3u8-parser');

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
  const baseURL = 'https://usher.ttvnw.net';
  const path = req.originalUrl;
  const playlist = path.substring(path.lastIndexOf('/') + 1);

  const useProxies = true;
  const isVOD = !channel;

  console.log(`Fetching ${isVOD ? `VOD (${vodId})` : `playlist (${channel})`}`);

  axios
    .get(`${baseURL}${path}`)
    .then(({ data, status }) => {
      if (status != 200) throw new Error(`usher returned ${status}`);
      console.log('usher success');
      parser.push(data);
      parser.end();
      const suppress = parser.manifest.custom.twitchInfo.SUPPRESS;
      // Not sure if this flag is available for VODs, for now we'll just use the proxy anyways
      if (isVOD || suppress === 'true') {
        const proxies = [];
        if (useProxies) {
          proxies.push(
            axios.get('https://api.ttv.lol/ping').then(({ status }) => {
              if (status != 200) throw new Error('ttv.lol unreachable');
              return axios
                .get(
                  `https://api.ttv.lol/${
                    isVOD ? 'vod' : 'playlist'
                  }/${encodeURIComponent(playlist)}`,
                  {
                    headers: {
                      'X-Donate-To': 'https://ttv.lol/donate',
                    },
                  }
                )
                .then(({ data, status }) => {
                  if (status != 200)
                    throw new Error(`ttv.lol returned ${status}`);
                  if (!data.startsWith('#EXTM3U'))
                    throw new Error('ttv.lol returned invalid playlist');
                  console.log('ttv.lol success');
                  return data;
                });
            })
          );

          if (!isVOD) {
            proxies.push(
              axios.head('https://jupter.ga').then(({ status }) => {
                if (status != 200) throw new Error('jupter.ga unreachable');
                return axios
                  .get(`https://jupter.ga/channel/${channel}`)
                  .then(({ data, status }) => {
                    if (status != 200)
                      throw new Error(`jupter.ga returned ${status}`);
                    if (!data.startsWith('#EXTM3U'))
                      throw new Error('jupter.ga returned invalid playlist');
                    console.log('jupter.ga success');
                    return data;
                  });
              })
            );
          }
        }

        Promise.any(proxies)
          .then((result) => {
            if (!result) {
              throw new Error('No proxy result');
            } else {
              res.setHeader(
                'Content-Length',
                Buffer.byteLength(result, 'utf8')
              );
              res.status(200).send(result).end();
            }
          })
          .catch((error) => {
            console.log(error.message);
            if (error instanceof AggregateError)
              error.errors.forEach((error) => console.log(error.message));
            console.log('All proxies failed, falling back to usher');
            res.status(200).send(data).end();
          });
      } else {
        console.log('Server ads not enabled');
        res.setHeader('Content-Length', Buffer.byteLength(data, 'utf8'));
        res.status(200).send(data).end();
      }
    })
    .catch((error) => {
      console.log(`usher ${error.message}`);
      res.status(404).end();
    });
}

router.get('/ping', (_, res) => {
  console.log('pong');
  res.status(200).send('1').end();
});

// For vods in the future
router.get('/vod/:vodId.m3u8', (req, res) => {
  handleRequest(req, res);
});

router.get('/api/channel/hls/:channel.m3u8', (req, res) => {
  handleRequest(req, res);
});

app.use(router);

module.exports = app;
module.exports.handler = serverless(app, { provider: 'aws' });
