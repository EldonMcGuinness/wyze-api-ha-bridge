# Wyze Sense v2 to Home Assistant MQTT bridge

This Portainer-ready Git stack runs a persistent Wyze cloud polling bridge and an authenticated Mosquitto MQTT broker. It polls Wyze Sense v2 contact sensors every 30 seconds and publishes Home Assistant MQTT Discovery entities.

The bridge uses the verified `wyze-api` calls from the referenced conversation: `getDeviceList()` and `getDeviceState(device)`, which returned `closed` for the user's DWS2U sensors. The default filter includes `DWS2U` contact sensors. `PIR2U` motion sensors remain excluded because their state behavior was not verified.

## Create the GitHub repository

Create a repository named `wyze-api-ha-bridge` and add the contents of this directory at the repository root. Keep `.github/workflows/publish-image.yml` in place. On a push to `main`, GitHub Actions builds the bridge image for `amd64` and `arm64` and publishes it to GitHub Container Registry (GHCR).

After the first successful workflow run, open the repository's **Packages** section, select `wyze-api-ha-bridge`, and set package visibility to **Public**. The repository can be public; the image also needs to be public so Portainer can pull it without registry credentials.

## Deploy in Portainer

1. In Portainer, open **Stacks → Add stack → Repository** and connect the `wyze-api-ha-bridge` repository. Set the Compose path to `docker-compose.yml` and use the `main` branch. The image must have been published and made public first.
2. Add stack environment variables from `.env.example`. Set `WYZE_EMAIL`, `WYZE_PASSWORD`, `WYZE_KEY_ID`, `WYZE_API_KEY`, `MQTT_USERNAME`, and `MQTT_PASSWORD`. Choose a unique, strong MQTT password. `MQTT_HOST_PORT` can stay `1883` unless that port is already in use on the Docker host.
3. Deploy. Portainer pulls the prebuilt bridge image and the official Mosquitto image. The bridge waits for the broker health check before starting; Portainer does not need to build an image or mount repository files.
4. Check the `wyze-mqtt-bridge` container logs. Expected lines include `Connected to MQTT broker` and `Polled 15 DWS2U contact sensor(s)`.
5. In Home Assistant, configure the MQTT integration to connect to the Docker host's LAN IP on port `1883`, using the `MQTT_USERNAME` and `MQTT_PASSWORD` values you set in Portainer. Do not use `localhost` unless Home Assistant shares the broker's network namespace. After connecting, discovery creates the sensor entities.

The stack file contains no actual credentials. Wyze explains how to create an API key in its [API key support article](https://support.wyze.com/hc/en-us/articles/16129834216731-Creating-an-API-Key).

## Updating the bridge image

When you push changes to `Dockerfile`, `index.js`, or `package.json`, GitHub Actions publishes a new `latest` image. In Portainer, pull and redeploy the stack with **Re-pull image and redeploy** enabled so it downloads that image. The Compose file stays in Git as the stack source.

## Behavior and operations

- The first Wyze poll starts immediately; later polls run every 30 seconds. Set `POLL_INTERVAL_SECONDS` to change the cadence (minimum 10 seconds).
- Mosquitto requires username/password authentication; anonymous access is disabled. Port `1883` is published on the Docker host for Home Assistant and other LAN clients.
- Discovery configs and sensor states are retained in MQTT. Opening maps to `ON`; closed maps to `OFF`.
- Wyze polling errors mark the bridge and known sensors unavailable. A later successful poll restores availability. MQTT.js reconnects to Mosquitto; Mosquitto has a broker health check and retained offline Last Will.
- Mosquitto persistence and the Wyze library cache/auth data use named volumes, surviving container recreation and Portainer stack updates. Removing the stack with volumes deletes both data volumes.
- Mosquitto creates its password file at startup from the MQTT environment variables. The file remains inside the broker container and is not committed to Git.

## Credential hygiene

- Enter Wyze and MQTT credentials in Portainer's stack environment-variable UI. Restrict Portainer access to trusted administrators; Docker environment values are visible to Docker administrators.
- Keep `.env` private and out of Git. `.gitignore` excludes it; `.env.example` contains placeholders only.
- This bridge does not log Wyze credentials or the MQTT password. Avoid sharing stack exports or container inspection output, which may contain environment variables.
- `wyze-api` is an unofficial client of Wyze's private APIs. Wyze can change those APIs and break polling.
