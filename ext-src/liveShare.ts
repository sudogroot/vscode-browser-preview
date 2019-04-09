import * as vsls from 'vsls/vscode';
import { BrowserViewWindowManager } from './BrowserViewWindowManager';

const SERVICE_NAME = 'browser-preview';
const REQUEST_GET_WINDOWS = 'getWindows';
const NOTIFICATION_WINDOW_CREATED = 'windowCreated';
const NOTIFICATION_WINDOW_DISPOSED = 'windowDisposed';
const NOTIFICATION_WINDOW_INTERACTION = 'windowInteraction';
const NOTIFICATION_WINDOW_RESIZED = 'windowResized';

const DISPATCHED_EVENTS = [
  'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent',
  'Page.goBackward',
  'Page.goForward',
  'Page.navigate',
  'Page.reload'
];

function log(message: string, ...params: any[]) {
  console.log(`Browser Preview (Live Share): ${message}`, ...params);
}

export async function setupLiveShare(windowManager: BrowserViewWindowManager) {
  const liveShare = await vsls.getApi();
  if (!liveShare) {
    log('Extension not installed, so skipping initialization');
    return;
  }

  await sessionStarted(liveShare);
  setupServices(liveShare, windowManager);
}

async function setupServices(liveShare: vsls.LiveShare, windowManager: BrowserViewWindowManager) {
  var service: vsls.SharedService | vsls.SharedServiceProxy;

  if (liveShare.session.role === vsls.Role.Host) {
    log('Initializing host service');
    service = (await liveShare.shareService(SERVICE_NAME))!;

    service.onRequest(REQUEST_GET_WINDOWS, () => {
      const windows = Array.from(windowManager.openWindows);
      const windowStates = windows.map((window) => window.getState());

      console.log('Returning browser windows to guest', windowStates);
      return windowStates;
    });
  } else if (liveShare.session.role === vsls.Role.Guest) {
    log('Initializing guest service');
    service = (await liveShare.getSharedService(SERVICE_NAME))!;

    if (!service) {
      log("Host doesn't have the Browsr Preview extension installed, skipping initialization");
      return;
    }

    const windows = await (<vsls.SharedServiceProxy>service).request(REQUEST_GET_WINDOWS, []);
    log('Requested windows', windows);
    if (windows && windows.length > 0) {
      windows.forEach(async (state: any) => {
        log('Creating window', state);
        const window = await windowManager.create(state.url, state.id);
        window.setViewport(state.viewportMetadata);
      });
    }

    service.onNotify(NOTIFICATION_WINDOW_CREATED, async (args: any) => {
      log('Window created', args);

      const window = await windowManager.create(args.url, args.id);
      window.setViewport(args.viewportMetadata);
    });

    service.onNotify(NOTIFICATION_WINDOW_DISPOSED, async (args: any) => {
      log('Window disposed', args);

      const window = windowManager.getById(args.id)!;
      window.dispose();
    });

    service.onNotify(NOTIFICATION_WINDOW_RESIZED, async (args: any) => {
      log('Window resized', args);

      const window = windowManager.getById(args.id)!;
      window.setViewport(args.viewportMetadata);
    });
  }

  handleRemoteInteractions(service!, liveShare, windowManager);
  handleLocalWindowCreation(service!, liveShare, windowManager);
}

function sessionStarted(liveShare: vsls.LiveShare) {
  return new Promise((resolve) => {
    if (liveShare.session.id) {
      resolve();
    } else {
      liveShare.onDidChangeSession((e) => {
        if (e.session.id) {
          resolve();
        }
      });
    }
  });
}

function handleRemoteInteractions(
  service: vsls.SharedService | vsls.SharedServiceProxy,
  liveShare: vsls.LiveShare,
  windowManager: BrowserViewWindowManager
) {
  log('Setting up remote listeners');
  service.onNotify(NOTIFICATION_WINDOW_INTERACTION, async (args: any) => {
    const { peerNumber, id, data } = args;

    if (peerNumber === liveShare.session.peerNumber) {
      // This is a re-broadcasted event from
      // the same user.
      return;
    }

    const window = windowManager.getById(id);
    log('Received client event', data, window);
    window!.browserPage!.send(data.type, data.params);

    if (liveShare.session.role === vsls.Role.Host) {
      service.notify(NOTIFICATION_WINDOW_INTERACTION, args);
    }
  });
}

function handleLocalWindowCreation(
  service: vsls.SharedService | vsls.SharedServiceProxy,
  liveShare: vsls.LiveShare,
  windowManager: BrowserViewWindowManager
) {
  log('Setting up local listeners');
  windowManager.on(NOTIFICATION_WINDOW_CREATED, async (id: string) => {
    const window = windowManager.getById(id)!;
    log('Window created', window);

    if (liveShare.session.role === vsls.Role.Host) {
      const intervalId = setInterval(function() {
        const state: any = window.getState();
        if (state.viewportMetadata && typeof state.viewportMetadata.height === 'number') {
          clearInterval(intervalId);
          log('Notifying guests of window', state);
          service.notify(NOTIFICATION_WINDOW_CREATED, { ...state, id: id });

          window.on('disposed', () => {
            log('Notifying guets of window disposal', state.id);
            service.notify(NOTIFICATION_WINDOW_DISPOSED, { id: window.id });
          });

          let previousDimensions = { height: state.viewportMetadata, width: state.viewportMetadata.width };
          window.on('stateChanged', () => {
            const { viewportMetadata } = <any>window.getState();
            if (
              viewportMetadata.height !== previousDimensions.height ||
              viewportMetadata.width !== previousDimensions.width
            ) {
              previousDimensions = { height: viewportMetadata.height, width: viewportMetadata.width };
              service.notify(NOTIFICATION_WINDOW_RESIZED, { id: window.id, viewportMetadata });
            }
          });
        }
      }, 1000);
    }

    // Listen for any local browser interactions,
    // and synronize them to all other guests.
    window.onAny(
      (type: string | string[], ...params: any[]): void => {
        if (!DISPATCHED_EVENTS.includes(type.toString())) {
          return;
        }

        log('Sending client event', type, params);

        service.notify(NOTIFICATION_WINDOW_INTERACTION, {
          peerNumber: liveShare.session.peerNumber,
          data: { params: params[0], type },
          id: window.id
        });
      }
    );
  });
}
