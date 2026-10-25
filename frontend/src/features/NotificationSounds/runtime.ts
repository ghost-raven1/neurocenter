import {createBrowserChime} from './browserChime';
import {createNotificationSounds} from './controller';

/** Browser access is deferred; importing the feature neither opens audio nor reads another account. */
export const notificationSounds = createNotificationSounds({audio: createBrowserChime,
    storage: {getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value)},
    now: () => Date.now(), schedule: (run, delay) => setTimeout(run, delay), cancel: timer => clearTimeout(timer)});
