import * as net from 'net';

export interface ConnectionHandler {
	connected();
	onData(data);
	onClose();
}

export class Connection {

	private _socket : net.Socket;
	private _handler : ConnectionHandler;
	private _retries : number = 0;

	constructor() {
		this._socket = new net.Socket();
	}

	public init(handler : ConnectionHandler) {
		this._handler = handler;
	}

	public connect(host:string = "127.0.0.1", port:number = 31666) {
		// this._socket.connect(port, host, () => {
		// 	this._handler.connected();
		// 	// this._retries = -1;
		// });
		this._socket.on('data', (data) => this._handler.onData(data));
		this._socket.on('close', () => this._handler.onClose());
		this._socket.on('error', (err) => {
			if (this._retries >= 0 && this._retries < 10) {
				this._retries++;
				setTimeout(() => {
					this.doConnect(host, port);
				}, 500);
			}
		});
		this.doConnect(host, port);
	}

	public send(message:string) {
		this._socket.write(message);
	}
	private doConnect(host:string, port:number) {
		this._socket.connect(port, host, () => {
			this._handler.connected();
			this._retries = -1;
		});
	}
}
