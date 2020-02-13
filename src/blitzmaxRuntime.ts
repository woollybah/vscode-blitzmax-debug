/*---------------------------------------------------------
 * Copyright (C) 2020 Bruce A Henderson                   *
 *--------------------------------------------------------*/

import { EventEmitter } from 'events';
import * as child_process from 'child_process';
import { AsyncBlockingQueue } from './queue';
import { log } from'./common';
import { Connection, ConnectionHandler } from './connection';
import { Handles } from 'vscode-debugadapter';

enum DebugState {
    WAIT,
    READ_STACK,
	READ_DUMP
}

export enum DebugCommand {
    RUN,
    STEP,
    STEP_IN,
    STEP_OUT,
    STACKTRACE,
    DUMP,
    QUIT
}

export enum DebugSetType {
	UNKNOWN,
	DEBUGSTOP,
	STACKTRACE,
	OBJECTDUMP
}

export enum VariableScopeType {
	LOCAL,
	GLOBAL,
	CONST,
	FIELD,
	REF,
	INDEXED
}

class DebugSet {
	private _type : DebugSetType = DebugSetType.UNKNOWN;
    private _lines : string[] = [];

    constructor(buf:Buffer) {
        let lines : string[] = buf.toString().split(/\n/);

		let first = true;
        for (let line of lines) {
            if (line.length > 0) {
                line = this.removePrefix(line);
                if (line.length > 0) {
					if (first) {
						this.setType(line);
						first = false;
					}

					this._lines.push(line);
                }
            }
        }
    }

	setType(line: string) {
		log("line=`" + line + "'");
		switch(line) {
			case "Debug:":
			case "DebugStop:":
				this._type = DebugSetType.DEBUGSTOP;
				return;
			case "StackTrace{":
				this._type = DebugSetType.STACKTRACE;
				return;
		}
		if (line.startsWith("ObjectDump@")) {
			this._type = DebugSetType.OBJECTDUMP;
		}
	}

    removePrefix(line:string) : string {
        return line.replace("~>", "");
    }

    public lines() : string[] {
        return this._lines;
	}

	public type() : DebugSetType {
		return this._type;
	}
}

export interface MaxSourceInfo {
	path : string;
	line : number;
	column : number;
}

export interface MaxVariable {
	scopeType : VariableScopeType,
	type : string,
	name : string,
	value? : string,
	ref? : string,
	refId? : number,
	length? : number
}

export interface MaxScopedVariables {
	scopeType : string,
	ref : number,
	variables : MaxVariable[],
	myRef? : string
}

export interface MaxVariableSet {
	scopedVariables : Map<string, MaxScopedVariables>
}

class MaxStack {
	private _scopeHandles = new Handles<string>(2000);
	// private _variableHandles = new Handles<string>(5000);
	private _frames : MaxStackFrame[] = [];

	public push(frame:MaxStackFrame) {
		this._frames.push(frame);
	}

	public frames() : MaxStackFrame[] {
		return this._frames;
	}

	public reindex() {
		this._frames = this._frames.reverse();
		let index : number = 0;
		for( let entry of this._frames) {
			entry.setIndex(index++);
		}
	}

	public length() : number {
		return this._frames.length;
	}

	public createScopeId(scope:string) : number {
		return this._scopeHandles.create(scope);
	}

	public refToInstance(refId:number) : string {
		return this._scopeHandles.get(refId);
	}

}

class MaxScope {
	protected _name : string;
	protected _set : MaxVariableSet;

	private _stack : MaxStack;

	constructor(stack : MaxStack) {
		this._stack = stack;

		this._set = {
			scopedVariables : new Map<string, MaxScopedVariables>()
		};
	}

	public setName(name:string) {
		this._name = name;
	}

	public name() : string {
		return this._name;
	}

	public addScopedVariable(scope:string, variable:MaxVariable, scopes:Map<number, MaxScopedVariables>) {

		let scopedVariables = this._set.scopedVariables.get(scope);

		if (scopedVariables == undefined) {
			scopedVariables = {
				scopeType : scope,
				ref : variable.refId ? variable.refId : this._stack.createScopeId(scope),
				variables : [],
				myRef : variable.ref
			}

			this._set.scopedVariables.set(scope, scopedVariables);
			scopes.set(scopedVariables.ref, scopedVariables);

			if (variable.ref) {
				return;
			}
		}

		scopedVariables.variables.push(variable);
	}

	public variableSet() : MaxVariableSet {
		return this._set;
	}

	public parseVariable(scopeType:VariableScopeType, line:string) : MaxVariable {
		let variable : MaxVariable;
		let vpos = line.indexOf("=");

		if (line.startsWith("[")) {
			variable = {
				scopeType : scopeType,
				name : line.substring(0, vpos),
				type : ""
			};

		} else {
			let tpos = line.indexOf(":");

			if (tpos == -1 && line.startsWith("<local>")) {
				tpos = line.indexOf(">") + 1;
			}
			variable = {
				scopeType : scopeType,
				name : line.substring(0, tpos),
				type : line.substring(tpos + 1, vpos)
			};
		}

		let value = line.substring(vpos + 1);

		if (value.startsWith("$")) {
			let lpos = value.indexOf(":");
			if (lpos > 0) {
				variable.length = +value.substring(lpos + 1);
				value = value.substring(0, lpos);
			}
			variable.ref = value;
			variable.refId = this._stack.createScopeId(value);
		} else {
			variable.value = value;
		}

		return variable;
	}

	public processStack(line:string, scopes:Map<number, MaxScopedVariables>) {
		if (line.startsWith("Function")) {
			this.setName(line.substring(9));
		} else if (line.startsWith("Local")) {
			let variable = this.parseVariable(VariableScopeType.LOCAL, line.substring(6));
			if (variable.name == "Self") {
				this.addScopedVariable("Self : " + variable.type, variable, scopes);
			} else if (variable.name == "<local>") {
				// TODO : handle this better
			} else {
				this.addScopedVariable("Local", variable, scopes);
			}
		} else if (line.startsWith("Const")) {
			let variable = this.parseVariable(VariableScopeType.CONST, line.substring(6));
			this.addScopedVariable("Const", variable, scopes);
		} else if (line.startsWith("Global")) {
			let variable = this.parseVariable(VariableScopeType.GLOBAL, line.substring(7));
			this.addScopedVariable("Global", variable, scopes);
		} else if (line.startsWith("Field")) {
			let variable = this.parseVariable(VariableScopeType.FIELD, line.substring(6));
			this.addScopedVariable("Field", variable, scopes);
		} else if (line.startsWith("[")) {
			let variable = this.parseVariable(VariableScopeType.INDEXED, line.substring(0));
			this.addScopedVariable("<indexed>", variable, scopes);
		}
	}

	public mergeFrame(frameNumber:number) {
		if (frameNumber >= 0) {
			let frame = this._stack.frames()[frameNumber];
			for (let scope of frame._set.scopedVariables.keys()) {
				let scoped = frame._set.scopedVariables.get(scope);
				if (scoped) {
					let scopedVariables = {
						scopeType : scoped.scopeType,
						ref : (scoped.myRef) ? scoped.ref : this._stack.createScopeId(scope),
						variables : Object.assign([], scoped.variables),
						myRef : scoped.myRef
					}

					this._set.scopedVariables.set(scope, scopedVariables);
				}
			}
		}
	}
}

class MaxStackFrame extends MaxScope {
	private _index : number = 0;
	private _source : MaxSourceInfo;

	constructor(sourceLine:string, stack:MaxStack) {
		super(stack);

		let numbers = sourceLine.substring(sourceLine.indexOf("<") + 1, sourceLine.indexOf(">")).split(",");
		let path = sourceLine.substring(1, sourceLine.indexOf("<"));

		this._source = {
			path : path,
			line : +numbers[0],
			column : +numbers[1]
		}
	}

	public source() : MaxSourceInfo {
		return this._source;
	}

	public setIndex(index:number) {
		this._index = index;
	}

	public index() : number {
		return this._index;
	}
}

class DebugProcessor {
	private _connection : Connection = new Connection();

	private _state : DebugState = DebugState.WAIT;
	private _buflen: number = -1;
	private _buffer: Buffer = Buffer.alloc(0);
	private _blockingQueue = new AsyncBlockingQueue<DebugSet>();

	private _currentStack : MaxStack;
	private _emitter : EventEmitter;
	private _scopeRefs = new Map<number, MaxScopedVariables>();
	private _callback:(vars:MaxVariable[]) => void;

	constructor(emitter:EventEmitter) {
		this._emitter = emitter;
	}

	public connect(handler:ConnectionHandler) {
		this._connection.init(handler);
		this._connection.connect();
	}

    public pushData(data:Buffer) {
		log("data : " + data.toString());

		let done = false;

		if (this._buflen < 0) {
			let pos = data.indexOf(0);
			this._buflen = +data.subarray(0, pos).toString();
			data = Buffer.from(data.subarray(pos + 1));

//			log("data : '" + data.toString() + "'");
//			log("length = " + this._buflen);
		}

		this._buffer = Buffer.concat([this._buffer, data]);

		if (this._buflen <= this._buffer.length) {
			done = true;
		}

        if (done) {
			this._blockingQueue.enqueue(new DebugSet(this._buffer));
			this._buffer = Buffer.alloc(0);
			this._buflen = -1;
        }
    }

    public readSet() {
        this._blockingQueue.dequeue().then( set => this.process(set));
	}

	public scopedVariables(refId:number) {
		return this._scopeRefs.get(refId);
	}

	setDebugState(state: DebugState) {
		this._state = state;
	}

    public process(set:DebugSet) {
		log("Processing set : " + set.type());

        switch(this._state) {
            case DebugState.WAIT:
				if (set.type() == DebugSetType.DEBUGSTOP) {
					this.sendCommand(DebugCommand.STACKTRACE);
				}
                break;
            case DebugState.READ_STACK:
				if (set.type() == DebugSetType.STACKTRACE) {
					this.buildStack(set);
					this.sendEvent('stopOnStep');
				}
                break;
            case DebugState.READ_DUMP:
				if (set.type() == DebugSetType.OBJECTDUMP) {
					this.processDump(set);
				}
                break;
        }

        this.readSet();
	}

	buildStack(set:DebugSet) {
		log("Building stack");

		this._currentStack = new MaxStack();
		this._scopeRefs.clear();

		let lines:string[] = set.lines();

		// let count = 0;
        for (let line of lines) {
			if (line == "StackTrace{" || line == "}") {
				continue;
			}
        	if (line.startsWith("@")) {
				this._currentStack.push(new MaxStackFrame(line, this._currentStack));
			} else {
				let stackFrame = this._currentStack.frames()[this._currentStack.length()-1];
				stackFrame.processStack(line, this._scopeRefs);
			}
		}

		// reindex
		this._currentStack.reindex();
	}

	processDump(set:DebugSet) {
		log("processing dump");

		let lines:string[] = set.lines();

		let scope = new MaxScope(this._currentStack);

		// let count = 0;
        for (let line of lines) {
			if (line.startsWith("ObjectDump") || line == "}") {
				continue;
			}
			scope.processStack(line, this._scopeRefs);
		}

		let variables : MaxVariable[] = [];
		for (let scopedVariable of scope.variableSet().scopedVariables.values()) {
			for (let variable of scopedVariable.variables) {
				variables.push(variable);
			}
		}
		this._callback(variables);
	}

    sendCommand(cmd:DebugCommand, arg?:string) {
        switch(cmd) {
			case DebugCommand.RUN:
			case DebugCommand.STEP:
			case DebugCommand.STEP_IN:
			case DebugCommand.STEP_OUT:
					this._state = DebugState.WAIT;
				break;
            case DebugCommand.STACKTRACE:
				this._state = DebugState.READ_STACK;
				break;
			case DebugCommand.DUMP:
				this._state = DebugState.READ_DUMP;
				break;
        }

		let command:string = this.commandToString(cmd);
		if (arg) {
			command += arg;
		}

		console.log("Sending debug command : " + command);
		this._connection.send(command + "\n");
    }

    commandToString(cmd : DebugCommand) : string {
        switch (cmd) {
            case DebugCommand.RUN:
                return "r";
            case DebugCommand.STEP:
                return "s";
            case DebugCommand.STEP_IN:
                return "e";
            case DebugCommand.STEP_OUT:
                return "l";
            case DebugCommand.STACKTRACE:
                return "t";
            case DebugCommand.DUMP:
                return "d";
            case DebugCommand.QUIT:
                return "q";
        }
        return "";
	}

	public currentStack() : MaxStack {
		return this._currentStack;
	}


	private sendEvent(event: string, ... args: any[]) {
		setImmediate(_ => {
			this._emitter.emit(event, ...args);
		});
	}

	public dump(refId:string, callback:(vars:MaxVariable[]) => void, start?:number, count?:number) {
		this._callback = callback;
		let arg = refId.substring(1);
		if (start && count) {
			arg += ":" + start + "," + count;
		}
		this.sendCommand(DebugCommand.DUMP, arg);
	}

	end() {
		this.sendEvent('end');
	}
}

export interface MockBreakpoint {
	id: number;
	line: number;
	verified: boolean;
}

/**
 * A Mock runtime with minimal debugger functionality.
 */
export class BlitzMaxRuntime extends EventEmitter {

	private _process: child_process.ChildProcess;
	private _debugProcessor : DebugProcessor = new DebugProcessor(this);


	// the initial (and one and only) file we are 'debugging'
	private _sourceFile: string;
	public get sourceFile() {
		return this._sourceFile;
	}

	constructor() {
		super();
	}

	/**
	 * Start executing the given program.
	 */
	public start(program: string, stopOnEntry: boolean) {

		log("Starting runtime");


		this.verifyBreakpoints(this._sourceFile);

		program = program + ".debug.exe";

		this._process = child_process.spawn(program, [] );


		let handler : ConnectionHandler = {
			connected : () => this._debugProcessor.readSet(),
			onData : (data) => this._debugProcessor.pushData(data),
			onClose : () => {return;}
		};

		this._debugProcessor.connect(handler);

		this._process.on('exit', (code: number) => {
			this._debugProcessor.end();
        });
	}

	/**
	 * Continue execution to the end/beginning.
	 */
	public continue() {
		this.run();
	}

	/**
	 * Step to the next/previous non empty line.
	 */
	public step(cmd : DebugCommand) {
		this._debugProcessor.sendCommand(cmd);
	}

	/**
	 * Returns a fake 'stacktrace' where every 'stackframe' is a word from the current line.
	 */
	public stack(startFrame: number, endFrame: number): MaxStackFrame[] {
		return this._debugProcessor.currentStack().frames().slice(startFrame, endFrame);
	}

	public scopes(frameId: number) : MaxVariableSet {
		return this._debugProcessor.currentStack().frames()[frameId].variableSet();
	}

	public scopedVariables(refId:number) {
		return this._debugProcessor.scopedVariables(refId);
	}

	public dump(refId:number, variables:(variables:MaxVariable[]) => void, start?:number, count?:number) {
		let ref = this._debugProcessor.currentStack().refToInstance(refId);
		if (!ref) {
			variables([]);
		} else {
			this._debugProcessor.dump(ref, variables, start, count);
		}
	}

	public getBreakpoints(path: string, line: number): number[] {
/*
		const l = this._sourceLines[line];

		let sawSpace = true;
		const bps: number[] = [];
		for (let i = 0; i < l.length; i++) {
			if (l[i] !== ' ') {
				if (sawSpace) {
					bps.push(i);
					sawSpace = false;
				}
			} else {
				sawSpace = true;
			}
		}

		return bps;
		*/
		return [];
	}

	/*
	 * Set breakpoint in file with given line.
	 */
	public setBreakPoint(path: string, line: number) : MockBreakpoint | undefined {
/*
		const bp = <MockBreakpoint> { verified: false, line, id: this._breakpointId++ };
		let bps = this._breakPoints.get(path);
		if (!bps) {
			bps = new Array<MockBreakpoint>();
			this._breakPoints.set(path, bps);
		}
		bps.push(bp);

		this.verifyBreakpoints(path);

		return bp;
		*/
		return undefined;
	}

	/*
	 * Clear breakpoint in file with given line.
	 */
	public clearBreakPoint(path: string, line: number) : MockBreakpoint | undefined {
		/*
		let bps = this._breakPoints.get(path);
		if (bps) {
			const index = bps.findIndex(bp => bp.line === line);
			if (index >= 0) {
				const bp = bps[index];
				bps.splice(index, 1);
				return bp;
			}
		}
		return undefined;
		*/
		return undefined;
	}

	/*
	 * Clear all breakpoints for file.
	 */
	public clearBreakpoints(path: string): void {
		// this._breakPoints.delete(path);
	}

	/*
	 * Set data breakpoint.
	 */
	public setDataBreakpoint(address: string): boolean {
		return false;
		/*
		if (address) {
			this._breakAddresses.add(address);
			return true;
		}
		return false;
		*/
	}

	/*
	 * Clear all data breakpoints.
	 */
	public clearAllDataBreakpoints(): void {
		// this._breakAddresses.clear();
	}

	// private methods

	// private loadSource(file: string) {
	// 	/*
	// 	if (this._sourceFile !== file) {
	// 		this._sourceFile = file;
	// 		this._sourceLines = readFileSync(this._sourceFile).toString().split('\n');
	// 	}
	// 	*/
	// }

	/**
	 * Run through the file.
	 * If stepEvent is specified only run a single step and emit the stepEvent.
	 */
	private run() {
		this._debugProcessor.sendCommand(DebugCommand.RUN);
		/*
		if (reverse) {
			for (let ln = this._currentLine-1; ln >= 0; ln--) {
				if (this.fireEventsForLine(ln, stepEvent)) {
					this._currentLine = ln;
					return;
				}
			}
			// no more lines: stop at first line
			this._currentLine = 0;
			this.sendEvent('stopOnEntry');
		} else {
			for (let ln = this._currentLine+1; ln < this._sourceLines.length; ln++) {
				if (this.fireEventsForLine(ln, stepEvent)) {
					this._currentLine = ln;
					return true;
				}
			}
			// no more lines: run to end
			this.sendEvent('end');
		}
		*/
	}

	private verifyBreakpoints(path: string) : void {
		/*
		let bps = this._breakPoints.get(path);
		if (bps) {
			this.loadSource(path);
			bps.forEach(bp => {
				if (!bp.verified && bp.line < this._sourceLines.length) {
					const srcLine = this._sourceLines[bp.line].trim();

					// if a line is empty or starts with '+' we don't allow to set a breakpoint but move the breakpoint down
					if (srcLine.length === 0 || srcLine.indexOf('+') === 0) {
						bp.line++;
					}
					// if a line starts with '-' we don't allow to set a breakpoint but move the breakpoint up
					if (srcLine.indexOf('-') === 0) {
						bp.line--;
					}
					// don't set 'verified' to true if the line contains the word 'lazy'
					// in this case the breakpoint will be verified 'lazy' after hitting it once.
					if (srcLine.indexOf('lazy') < 0) {
						bp.verified = true;
						this.sendEvent('breakpointValidated', bp);
					}
				}
			});
		}
		*/
	}

	/**
	 * Fire events if line has a breakpoint or the word 'exception' is found.
	 * Returns true is execution needs to stop.
	 */
	// private fireEventsForLine(ln: number, stepEvent?: string): boolean {
	// 	return false;
	// }
/*
		const line = this._sourceLines[ln].trim();

		// if 'log(...)' found in source -> send argument to debug console
		const matches = /log\((.*)\)/.exec(line);
		if (matches && matches.length === 2) {
			this.sendEvent('output', matches[1], this._sourceFile, ln, matches.index)
		}

		// if a word in a line matches a data breakpoint, fire a 'dataBreakpoint' event
		const words = line.split(" ");
		for (let word of words) {
			if (this._breakAddresses.has(word)) {
				this.sendEvent('stopOnDataBreakpoint');
				return true;
			}
		}

		// if word 'exception' found in source -> throw exception
		if (line.indexOf('exception') >= 0) {
			this.sendEvent('stopOnException');
			return true;
		}

		// is there a breakpoint?
		const breakpoints = this._breakPoints.get(this._sourceFile);
		if (breakpoints) {
			const bps = breakpoints.filter(bp => bp.line === ln);
			if (bps.length > 0) {

				// send 'stopped' event
				this.sendEvent('stopOnBreakpoint');

				// the following shows the use of 'breakpoint' events to update properties of a breakpoint in the UI
				// if breakpoint is not yet verified, verify it now and send a 'breakpoint' update event
				if (!bps[0].verified) {
					bps[0].verified = true;
					this.sendEvent('breakpointValidated', bps[0]);
				}
				return true;
			}
		}

		// non-empty line
		if (stepEvent && line.length > 0) {
			this.sendEvent(stepEvent);
			return true;
		}

		// nothing interesting found -> continue
		return false;
		*/
	// }

	// private sendEvent(event: string, ... args: any[]) {
	// 	setImmediate(_ => {
	// 		this.emit(event, ...args);
	// 	});
	// }
}