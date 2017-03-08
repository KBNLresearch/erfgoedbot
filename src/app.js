/*
 * Copyright 2016-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* jshint node: true, devel: true */
'use strict';

const fs = require('fs');

const config = fs.existsSync('config/production.json')
    ? JSON.parse(fs.readFileSync('config/production.json', 'utf-8'))
    : {
        "appSecret": process.env.MESSENGER_APP_SECRET,
        "pageAccessToken": process.env.MESSENGER_PAGE_ACCESS_TOKEN,
        "validationToken": process.env.MESSENGER_VALIDATION_TOKEN,
        "serverURL": process.env.SERVER_URL,
        "pathPrefix": "",
        "port": process.env.PORT
    };

const fb = require("./fb/fb-lib")(config);

const
    bodyParser = require('body-parser'),
    crypto = require('crypto'),
    express = require('express'),
    https = require('https'),
    request = require('request'),
    bot = require('./bot.js'),
    _ = require('lodash');


// App Secret can be retrieved from the App Dashboard
const APP_SECRET = config.appSecret;

// Arbitrary value used to validate a webhook
const VALIDATION_TOKEN = config.validationToken;

// Generate a page access token for your page from the App Dashboard
const PAGE_ACCESS_TOKEN = config.pageAccessToken;

// URL where the app is running (include protocol). Used to point to scripts and
// assets located at this address.
const SERVER_URL = config.serverURL;

const PATH_PREFIX = config.pathPrefix;

const app = express();
app.set('port', config.port);
app.set('view engine', 'ejs');
app.use(bodyParser.json({verify: verifyRequestSignature}));
app.use(PATH_PREFIX, express.static('public'));


// Validate webhook
app.get(`${PATH_PREFIX}/webhook`, fb.validateWebhook);

/*
 * All callbacks for Messenger are POST-ed. They will be sent to the same
 * webhook. Be sure to subscribe your app to your page to receive callbacks
 * for your page.
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 *
 */
app.post(`${PATH_PREFIX}/webhook`, function (req, res) {
    const data = req.body;

    // Make sure this is a page subscription
    if (data.object == 'page') {
        // Iterate over each entry
        // There may be multiple if batched
        data.entry.forEach(function (pageEntry) {

            // Iterate over each messaging event
            pageEntry.messaging.forEach(function (messagingEvent) {
                if (messagingEvent.optin) {
                    receivedAuthentication(messagingEvent);
                } else if (messagingEvent.message) {
                    receivedMessage(messagingEvent);
                } else if (messagingEvent.delivery) {
                    receivedDeliveryConfirmation(messagingEvent);
                } else if (messagingEvent.postback) {
                    receivedPostback(messagingEvent);
                } else if (messagingEvent.read) {
                    receivedMessageRead(messagingEvent);
                } else if (messagingEvent.account_linking) {
                    receivedAccountLink(messagingEvent);
                } else {
                    console.log("Webhook received unknown messagingEvent: ", messagingEvent);
                }
            });
        });

        // Assume all went well.
        //
        // You must send back a 200, within 20 seconds, to let us know you've
        // successfully received the callback. Otherwise, the request will time out.
        res.sendStatus(200);
    }
});

/*
 * This path is used for account linking. The account linking call-to-action
 * (sendAccountLinking) is pointed to this URL.
 *
 */
app.get(`${PATH_PREFIX}/authorize`, function (req, res) {
    const accountLinkingToken = req.query.account_linking_token;
    const redirectURI = req.query.redirect_uri;

    // Authorization Code should be generated per user by the developer. This will
    // be passed to the Account Linking callback.
    const authCode = "1234567890";

    // Redirect users to this URI on successful login
    const redirectURISuccess = redirectURI + "&authorization_code=" + authCode;

    res.render('authorize', {
        accountLinkingToken: accountLinkingToken,
        redirectURI: redirectURI,
        redirectURISuccess: redirectURISuccess
    });
});

/*
 * Verify that the callback came from Facebook. Using the App Secret from
 * the App Dashboard, we can verify the signature that is sent with each
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */
function verifyRequestSignature(req, res, buf) {
    const signature = req.headers["x-hub-signature"];

    if (!signature) {
        // For testing, let's log an error. In production, you should throw an
        // error.
        console.error("Couldn't validate the signature.");
    } else {
        const elements = signature.split('=');
        const method = elements[0];
        const signatureHash = elements[1];

        const expectedHash = crypto.createHmac('sha1', APP_SECRET)
            .update(buf)
            .digest('hex');

        if (signatureHash != expectedHash) {
            throw new Error("Couldn't validate the request signature.");
        }
    }
}

/*
 * Authorization Event
 *
 * The value for 'optin.ref' is defined in the entry point. For the "Send to
 * Messenger" plugin, it is the 'data-ref' field. Read more at
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/authentication
 *
 */
function receivedAuthentication(event) {
    const senderID = event.sender.id;
    const recipientID = event.recipient.id;
    const timeOfAuth = event.timestamp;

    // The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
    // The developer can set this to an arbitrary value to associate the
    // authentication callback with the 'Send to Messenger' click event. This is
    // a way to do account linking when the user clicks the 'Send to Messenger'
    // plugin.
    const passThroughParam = event.optin.ref;

    console.log("Received authentication for user %d and page %d with pass " +
        "through param '%s' at %d", senderID, recipientID, passThroughParam,
        timeOfAuth);

    // When an authentication is received, we'll send a message back to the sender
    // to let them know it was successful.
    sendTextMessage(senderID, "Authentication successful");
}


/*
 * Message Event
 *
 * This event is called when a message is sent to your page. The 'message'
 * object format can vary depending on the kind of message that was received.
 * Read more at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-received
 *
 * For this example, we're going to echo any text that we get. If we get some
 * special keywords ('button', 'generic', 'receipt'), then we'll send back
 * examples of those bubbles to illustrate the special message bubbles we've
 * created. If we receive a message with an attachment (image, video, audio),
 * then we'll simply confirm that we've received the attachment.
 *
 */
function receivedMessage(event) {
    const senderID = event.sender.id;
    const recipientID = event.recipient.id;
    const timeOfMessage = event.timestamp;
    const message = event.message;

    console.log("Received message for user %d and page %d at %d with message:", senderID, recipientID, timeOfMessage);
    console.log(JSON.stringify(message));

    const isEcho = message.is_echo;
    const messageId = message.mid;
    const appId = message.app_id;
    const metadata = message.metadata;
    const quickReply = message.quick_reply;

    if (isEcho) {
        // Just logging message echoes to console
        console.log("Received echo for message %s and app %d with metadata %s", messageId, appId, metadata);
        return;
    } else if (quickReply) {
        const quickReplyPayload = quickReply.payload;
        console.log("Quick reply for message %s with payload %s", messageId, quickReplyPayload);
        sendTextMessage(senderID, "Quick reply tapped");
        return;
    }

    function handleSearchResponse(err, data) {
        sendTypingOff(senderID);

        if (err) {
            sendTextMessage(senderID, err);
        } else {
            console.log(data);
            if (data.type === 'buttons') {
                sendButtonMessage(senderID, data.buttons);
            }

            if (data.type === 'images') {
                sendTextMessage(senderID, `Je gaat zo zien: ${data.images.label}, ${data.images.description}`);
                sendImageMessage(senderID, data.images.image);
                setTimeout(function () {
                    sendURL(senderID, `http://www.wikidata.org/wiki/${data.images.id}`);
                }, 3000);
            }

            if (data.type === 'text') {
                sendTextMessage(senderID, data.text);
            }
        }
    }

    // You may get a text or attachment but not both
    const messageText = message.text;

    // Currently the only type we support is text
    if (messageText) {
        const parsedMsg = messageText.trim().toLowerCase();
        sendTextMessage(senderID, "Ik ben nu aan het zoeken, een momentje...");
        sendTypingOn(senderID);


        if (parsedMsg.indexOf('-') !== -1) {
            const dates = parsedMsg.split('-');

            bot.painterByDate(dates[1], dates[0], handleSearchResponse);
        } else if (parsedMsg === 'utrecht') {
            bot.getMonuments(handleSearchResponse);
        } else if (parsedMsg === 'surprise') {
            bot.randomArtist(handleSearchResponse);
        } else {
            bot.searchPainters(parsedMsg, handleSearchResponse);
        }
    } else {
        sendTextMessage(senderID, "Sorry, dit snap ik even niet.");
    }

    return;
}


/*
 * Delivery Confirmation Event
 *
 * This event is sent to confirm the delivery of a message. Read more about
 * these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
 *
 */
function receivedDeliveryConfirmation(event) {
    const senderID = event.sender.id;
    const recipientID = event.recipient.id;
    const delivery = event.delivery;
    const messageIDs = delivery.mids;
    const watermark = delivery.watermark;
    const sequenceNumber = delivery.seq;

    if (messageIDs) {
        messageIDs.forEach(function (messageID) {
            console.log("Received delivery confirmation for message ID: %s",
                messageID);
        });
    }

    console.log("All message before %d were delivered.", watermark);
}


/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 *
 */
function receivedPostback(event) {
    const senderID = event.sender.id;
    const recipientID = event.recipient.id;
    const timeOfPostback = event.timestamp;

    // The 'payload' param is a developer-defined field which is set in a postback
    // button for Structured Messages.
    const payload = event.postback.payload;

    bot.paintingsByArtist(payload, (err, data) => {
        if (err) {
            sendTextMessage(senderID, `Er ging iets mis: ${err}`);
        } else {
            if (data.type === 'images') {
                sendTextMessage(senderID, `Je gaat zo zien: ${data.images.label}, ${data.images.description}`);
                sendImageMessage(senderID, data.images.image);
                console.log(data.images);

                if (data.images.collection) {
                    setTimeout(function () {
                        sendTextMessage(senderID, `Dit kun je trouwens zien in de collectie van ${data.images.collection}`)
                        const moreUrl = data.images.url ? data.images.url : `http://www.wikidata.org/wiki/${data.images.id}`;
                        sendURL(senderID, moreUrl);
                        sendButtonMessage(senderID, {
                            text: "Nog een werk van deze schilder?",
                            data: [{
                                title: "Ja, leuk!",
                                payload: data.images.author
                            }]
                        })
                    }, 5000);
                }
            }
        }
    });


    console.log("Received postback for user %d and page %d with payload '%s' " +
        "at %d", senderID, recipientID, payload, timeOfPostback);

    // When a postback is called, we'll send a message back to the sender to
    // let them know it was successful
    sendTextMessage(senderID, "Ik ben nu een schilderij aan het ophalen...");
}

/*
 * Message Read Event
 *
 * This event is called when a previously-sent message has been read.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-read
 *
 */
function receivedMessageRead(event) {
    const senderID = event.sender.id;
    const recipientID = event.recipient.id;

    // All messages before watermark (a timestamp) or sequence have been seen.
    const watermark = event.read.watermark;
    const sequenceNumber = event.read.seq;

    console.log("Received message read event for watermark %d and sequence " +
        "number %d", watermark, sequenceNumber);
}

/*
 * Account Link Event
 *
 * This event is called when the Link Account or UnLink Account action has been
 * tapped.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/account-linking
 *
 */
function receivedAccountLink(event) {
    const senderID = event.sender.id;
    const recipientID = event.recipient.id;

    const status = event.account_linking.status;
    const authCode = event.account_linking.authorization_code;

    console.log("Received account link event with for user %d with status %s " +
        "and auth code %s ", senderID, status, authCode);
}

/*
 * Send an image using the Send API.
 *
 */
function sendImageMessage(recipientId, url) {
    url = `${url}?width=800`;

    callSendAPI({
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: 'image',
                payload: {
                    url: url
                }
            }
        }
    });

    setTimeout(function () {
        sendTextMessage(recipientId, `${_.random(8, 50)} mensen zagen deze afbeelding ook, ${_.random(2, 4)} mensen kijken op dit moment`);
    }, 4000);


    return;

    const messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "image",
                payload: {
                    url: SERVER_URL + "/assets/rift.png"
                }
            }
        }
    };

    callSendAPI(messageData);
}

/*
 * Send a text message using the Send API.
 *
 */
function sendTextMessage(recipientId, messageText) {
    const messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: messageText,
            metadata: "DEVELOPER_DEFINED_METADATA"
        }
    };

    callSendAPI(messageData);
}

/*
 * Send a button message using the Send API.
 *
 */
function sendButtonMessage(recipientId, buttons) {
    const data = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    "template_type": "button",
                    "text": buttons.text,
                    buttons: buttons.data.map((b) => {
                        return {
                            type: "postback",
                            title: b.title,
                            payload: b.payload
                        }
                    })
                }
            }
        }
    };

    callSendAPI(data);
}

function sendURL(recId, url) {
    callSendAPI({
        recipient: {
            id: recId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    "template_type": "button",
                    "text": 'Wil je meer weten?',
                    buttons: [{
                        type: "web_url",
                        url: url,
                        title: "Lees verder"
                    }]
                }
            }
        }
    })
}


/*
 * Turn typing indicator on
 *
 */
function sendTypingOn(recipientId) {
    console.log("Turning typing indicator on");

    const messageData = {
        recipient: {
            id: recipientId
        },
        sender_action: "typing_on"
    };

    callSendAPI(messageData);
}

/*
 * Turn typing indicator off
 *
 */
function sendTypingOff(recipientId) {
    console.log("Turning typing indicator off");

    const messageData = {
        recipient: {
            id: recipientId
        },
        sender_action: "typing_off"
    };

    callSendAPI(messageData);
}

/*
 * Call the Send API. The message data goes in the body. If successful, we'll
 * get the message id in a response
 *
 */
function callSendAPI(messageData) {
    if (process.env.MODE === 'mock') {
        console.log(JSON.stringify(messageData, null, 2));
        return;
    }

    request({
        uri: 'https://graph.facebook.com/v2.6/me/messages',
        qs: {access_token: PAGE_ACCESS_TOKEN},
        method: 'POST',
        json: messageData

    }, function (error, response, body) {
        if (!error && response.statusCode == 200) {
            const recipientId = body.recipient_id;
            const messageId = body.message_id;

            if (messageId) {
                console.log("Successfully sent message with id %s to recipient %s", messageId, recipientId);
            } else {
                console.log("Successfully called Send API for recipient %s", recipientId);
            }
            console.log("Message data was:", JSON.stringify(messageData, null, 2));
            console.log("=====\n\n")

        } else {
            console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
            console.error("Message data was:", JSON.stringify(messageData, null, 2));
            console.error("=====\n\n")
        }
    });
}

// Start server
// Webhooks must be available via SSL with a certificate signed by a valid
// certificate authority.
app.listen(app.get('port'), function () {
    console.log('Node app is running on port', app.get('port'));
});

module.exports = app;