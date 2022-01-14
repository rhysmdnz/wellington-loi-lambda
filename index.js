const https = require('https');
const aws = require('aws-sdk');
const s3 = new aws.S3();

const WEBHOOK_SECRET = '**REDACTED**';
const UPTIME_SECRET_URL = '**REDACTED**';

const LOC_API_URL = 'https://api.integration.covid19.health.nz/locations' +
    '/v1/current-locations-of-interest';
const WEBHOOK_URL = 'https://discord.com/api/webhooks/' + WEBHOOK_SECRET;
const BUCKET_NAME = 'printfn-data-unversioned';
const FILE_NAME = 'locs.json';

exports.handler = async (event) => {
    aws.config.update({ region: "ap-southeast-2" });

    const [locationsString, knownLocs] = await Promise.all([
        postJSON(LOC_API_URL, {}, 'GET'),
        readFromS3()
    ]);
    const locations = JSON.parse(locationsString).items;
    const announcements = [];
    const newKnownLocs = {};
    for (let loc of locations) {
        newKnownLocs[loc.eventId] = loc.updatedAt || loc.publishedAt;
        const city = loc.location.city;
        if (!(city == 'Lower Hutt'
            || city == 'Wellington'
            || city == 'Upper Hutt'
            || city == 'Porirua')) {
            continue;
        }
        if (knownLocs[loc.eventId]) {
            // we've seen this LOC before, but we need to check if it's been updated
            if (!loc.updatedAt) continue;
            const lastSeenDate = Date.parse(knownLocs[loc.eventId]);
            const updatedDate = Date.parse(loc.updatedAt);
            if (!lastSeenDate || !updatedDate) continue;
            if (updatedDate > lastSeenDate) {
                // the LOC has been updated since we last saw it
                announcements.push(stringifyLOC(true, loc));
                continue;
            }
            continue;
        }
        announcements.push(stringifyLOC(false, loc));
    }
    console.log(`announcing ${announcements.length} locs:`);
    console.log(announcements);
    await Promise.all([
        writeToS3(newKnownLocs),
        pushToDiscord(announcements),
    ]);
    console.log(`Finished successfully. Found ${locations.length} total locs.`);
    console.log('uptime ping:', await postJSON(UPTIME_SECRET_URL, {}));
    const response = {
        statusCode: 200,
        body: JSON.stringify(`OK`),
    };
    return response;
};

const pushToDiscord = async announcements => {
    if (announcements.length == 0) {
        return;
    }
    // API docs: https://discord.com/developers/docs/resources/webhook#execute-webhook
    let currentDiscordContent = '';
    const push = async () => {
        console.log(`pushing ${currentDiscordContent.length} chars to discord...`);
        const res = await postJSON(WEBHOOK_URL, {
            content: currentDiscordContent,
            username: 'Wellington Locations of Interest Bot',
            avatar_url: 'https://i.imgur.com/b50ktJm.jpg'
        });
        console.log(`Discord response: ${res}`);
        try {
            if (res.length > 0) {
                let obj = JSON.parse(res);
                if (obj.retry_after) {
                    console.log(`exceeded rate limit, sleeping for ${obj.retry_after} seconds...`);
                    await sleep(obj.retry_after * 1000);
                    await push();
                }
            }
        } catch (err) {
        }
        currentDiscordContent = '';
    };
    for (const announcement of announcements) {
        if (currentDiscordContent.length + announcement.length > 1800) {
            await push();
        }
        if (currentDiscordContent.length > 0) {
            currentDiscordContent += '\n\n';
        }
        currentDiscordContent += announcement;
    }
    await push();
};

const formatDate = dateStr => {
    const date = new Date(Date.parse(dateStr));
    return date.toLocaleString('en-NZ', {
        timeZone: 'Pacific/Auckland',
        dateStyle: 'medium',
        timeStyle: 'short',
    });
};

const stringifyLOC = (updated, loc) => {
    const startDateStr = formatDate(loc.startDateTime);
    const endDateStr = formatDate(loc.endDateTime);
    let header = '';
    if (loc.exposureType == 'Close') {
        header = updated ? 'UPDATED HIGH-RISK LOCATION:' : 'NEW HIGH-RISK LOCATION:';
        header = `:rotating_light::rotating_light::rotating_light: **${header}**`;
        header += ' :rotating_light::rotating_light::rotating_light:';
    } else {
        header = updated ? 'UPDATED LOCATION:' : 'NEW LOCATION:';
        header = `:rotating_light: **${header}**`;
    }
    return `${header}\n` +
        `:question: ${loc.eventName}\n` +
        `:round_pushpin: ${loc.location.address}\n` +
        `:calendar_spiral: Start: **${startDateStr}**\n` +
        `:calendar_spiral: End: **${endDateStr}**\n` +
        (loc.updatedAt ? `Updated: ${formatDate(loc.updatedAt)}\n` : '') +
        `Exposure Type: **${loc.exposureType}**\n` +
        `Advice: ${loc.publicAdvice}`;
    /*
    {
      "eventId": "a0l4a0000006n8SAAQ",
      "eventName": "BP Connect Ōtaki",
      "startDateTime": "2022-01-05T01:50:00.000Z",
      "endDateTime": "2022-01-05T03:00:00.000Z",
      "publicAdvice": "Self-monitor for COVID-19 symptoms for 10 days after you were exposed. If symptoms develop, get a test and stay at home until you get a negative test result.",
      "visibleInWebform": false,
      "publishedAt": "2022-01-11T05:00:00.000Z",
      "updatedAt": "2022-01-11T20:00:00.000Z",
      "exposureType": "Casual",
      "location": {
        "latitude": "-40.760775",
        "longitude": "175.157554",
        "suburb": "",
        "city": "Otaki",
        "address": "250 Main Highway, Otaki 5512"
      }
    }
    */
};

const readFromS3 = async () => {
    try {
        const res = await s3.getObject({
            Bucket: BUCKET_NAME,
            Key: FILE_NAME
        }).promise();
        const existingFileContents = res.Body ? res.Body : Buffer.from("{}");
        console.log(`successfully read ${existingFileContents.length} bytes from S3`);
        const object = JSON.parse(existingFileContents);
        return object;
    } catch (err) {
        console.log(`S3 GetObject error, ignoring...: ${err}`);
        return {};
    }
};

const writeToS3 = async obj => {
    const body = JSON.stringify(obj);
    await s3.upload({
        Bucket: BUCKET_NAME,
        Key: FILE_NAME,
        Body: body,
        StorageClass: 'STANDARD',
        ContentType: 'text/plain'
    }).promise();
    console.log(`successfully uploaded ${body.length} bytes to s3://${BUCKET_NAME}/${FILE_NAME}`);
};

const postJSON = (url, jsonBody, method='POST', headers={}) => {
  return new Promise(function(resolve, reject) {
    let postData = Buffer.from(JSON.stringify(jsonBody), 'utf8');
    let req = https.request(url, {
      method,
      headers: {
        'Content-Type': 'application/json ; charset=UTF-8',
        'Content-Length': postData.length,
        ...headers
      }
    }, res => {
      res.setEncoding("utf8");
      let body = "";
      res.on("data", data => {
        body += data;
      });
      res.on("end", () => {
        resolve(body);
      });
    });
    req.write(postData);
    req.end();
  });
};

const sleep = ms => {
    return new Promise(resolve => setTimeout(resolve, ms));
};
