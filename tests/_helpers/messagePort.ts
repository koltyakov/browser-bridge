export type MessagePortEndpoint<PostedMessage, ReceivedMessage> = {
  port: {
    name: string;
    onMessage: {
      addListener: (listener: (message: ReceivedMessage) => void) => void;
    };
    onDisconnect: {
      addListener: (listener: () => void) => void;
    };
    postMessage: (message: PostedMessage) => void;
    disconnect: () => void;
  };
  postedMessages: PostedMessage[];
  onMessageListeners: Array<(message: ReceivedMessage) => void>;
  onDisconnectListeners: Array<() => void>;
  dispatchMessage: (message: ReceivedMessage) => void;
  dispatchDisconnect: () => void;
};

type MutableMessagePortEndpoint<PostedMessage, ReceivedMessage> = MessagePortEndpoint<
  PostedMessage,
  ReceivedMessage
> & {
  setPeerDispatch: (dispatch: (message: PostedMessage) => void) => void;
  setDisconnectPair: (disconnectPair: () => void) => void;
};

function createMessagePortEndpoint<PostedMessage, ReceivedMessage>(
  name: string
): MutableMessagePortEndpoint<PostedMessage, ReceivedMessage> {
  const postedMessages: PostedMessage[] = [];
  const onMessageListeners: Array<(message: ReceivedMessage) => void> = [];
  const onDisconnectListeners: Array<() => void> = [];
  let connected = true;
  let peerDispatch: (message: PostedMessage) => void = () => {};
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

export type MessagePortPairOptions = {
  leftName?: string;
  rightName?: string;
};

export type MessagePortPair<LeftMessage, RightMessage> = {
  left: MessagePortEndpoint<LeftMessage, RightMessage>;
  right: MessagePortEndpoint<RightMessage, LeftMessage>;
};

// Create a connected pair of inspectable message ports for runtime/UI tests.
export function createMessagePortPair<LeftMessage, RightMessage>({
  leftName = 'left',
  rightName = 'right',
}: MessagePortPairOptions = {}): MessagePortPair<LeftMessage, RightMessage> {
  const left = createMessagePortEndpoint<LeftMessage, RightMessage>(leftName);
  const right = createMessagePortEndpoint<RightMessage, LeftMessage>(rightName);

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
