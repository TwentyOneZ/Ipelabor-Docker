const mqtt = require('mqtt');
const config = require('./config');
const logger = require('./logger');

let client;

function connectMQTT() {
    return new Promise((resolve) => {
        client = mqtt.connect(config.mqtt.broker, {
            username: config.mqtt.username,
            password: config.mqtt.password
        });

        client.on('connect', () => {
            logger.info('✅ Conectado ao broker MQTT');
            resolve(client);
        });

        client.on('error', (err) => {
            logger.error('❌ MQTT erro:', err.message);
            client.end();
            setTimeout(connectMQTT, 10000);
        });

        client.on('offline', () => {
            logger.warn('⚠️ MQTT offline');
            client.end();
            setTimeout(connectMQTT, 10000);
        });
    });
}

function getMQTT() {
    if (!client) throw new Error('MQTT não conectado');
    return client;
}

module.exports = { connectMQTT, getMQTT };