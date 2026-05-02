// @ts-check

/**
 * @template PostedMessage
 * @template ReceivedMessage
 * @typedef {{
 *   port: {
 *     name: string,
 *     onMessage: {
 *       addListener: (listener: (message: ReceivedMessage) => void) => void
 *     },
 *     onDisconnect: {
 *       addListener: (listener: () => void) => void
 *     },
 *     postMessage: (message: PostedMessage) => void,
 *     disconnect: () => void
 *   },
 *   postedMessages: PostedMessage[],
 *   onMessageListeners: Array<(message: ReceivedMessage) => void>,
 *   onDisconnectListeners: Array<() => void>,
 *   dispatchMessage: (message: ReceivedMessage) => void,
 *   dispatchDisconnect: () => void
 * }} MessagePortEndpoint
 */

/**
 * @template PostedMessage
 * @template ReceivedMessage
 * @param {string} name
 * @returns {MessagePortEndpoint<PostedMessage, ReceivedMessage> & {
 *   setPeerDispatch: (dispatch: (message: PostedMessage) => void) => void,
 *   setDisconnectPair: (disconnectPair: () => void) => void
 * }}
 */
function createMessagePortEndpoint(name) {
  /** @type {PostedMessage[]} */
  const postedMessages = [];
  /** @type {Array<(message: ReceivedMessage) => void>} */
  const onMessageListeners = [];
  /** @type {Array<() => void>} */
  const onDisconnectListeners = [];
  let connected = true;
  /** @type {(message: PostedMessage) => void} */
  let peerDispatch = () => {};
  /** @type {() => void} */
  let disconnectPair = () => {};

  return {
    port: {
      name,
      onMessage: {
        addListener(listener) {
          onMessageListeners.push(listener);
        },
      },
      onDisconnect: {
        addListener(listener) {
          onDisconnectListeners.push(listener);
        },
      },
      postMessage(message) {
        if (!connected) {
          return;
        }
        postedMessages.push(message);
        peerDispatch(message);
      },
      disconnect() {
        disconnectPair();
      },
    },
    postedMessages,
    onMessageListeners,
    onDisconnectListeners,
    dispatchMessage(message) {
      if (!connected) {
        return;
      }
      for (const listener of onMessageListeners) {
        listener(message);
      }
    },
    dispatchDisconnect() {
      if (!connected) {
        return;
      }
      connected = false;
      for (const listener of onDisconnectListeners) {
        listener();
      }
    },
    setPeerDispatch(dispatch) {
      peerDispatch = dispatch;
    },
    setDisconnectPair(nextDisconnectPair) {
      disconnectPair = nextDisconnectPair;
    },
  };
}

/**
 * Create a connected pair of inspectable message ports for runtime/UI tests.
 *
 * @template LeftMessage
 * @template RightMessage
 * @param {{
 *   leftName?: string,
 *   rightName?: string
 * }} [options]
 * @returns {{
 *   left: MessagePortEndpoint<LeftMessage, RightMessage>,
 *   right: MessagePortEndpoint<RightMessage, LeftMessage>
 * }}
 */
export function createMessagePortPair({ leftName = 'left', rightName = 'right' } = {}) {
  const left = createMessagePortEndpoint(leftName);
  const right = createMessagePortEndpoint(rightName);

  left.setPeerDispatch((message) => {
    right.dispatchMessage(message);
  });
  right.setPeerDispatch((message) => {
    left.dispatchMessage(message);
  });

  const disconnectPair = () => {
    left.dispatchDisconnect();
    right.dispatchDisconnect();
  };
  left.setDisconnectPair(disconnectPair);
  right.setDisconnectPair(disconnectPair);

  return { left, right };
}
