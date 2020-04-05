/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {
	Logger, logger,
	LoggingDebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
	Thread, StackFrame, Scope, Source, Handles
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { basename } from 'path';
import { BlitzMaxRuntime, MockBreakpoint, DebugCommand, MaxSourceInfo, VariableScopeType } from './blitzmaxRuntime';
import { log } from './common';

const { Subject } = require('await-notify');

// function timeout(ms) {
// 	return new Promise(resolve => setTimeout(resolve, ms));
// }

/**
 * This interface describes the mock-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the mock-debug extension.
 * The interface should always match this schema.
 */
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
}

export class BlitzMaxDebugSession extends LoggingDebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static THREAD_ID = 1;

	// a Mock runtime (or debugger)
	private _runtime: BlitzMaxRuntime;

	private _variableHandles = new Handles<string>();

	private _configurationDone = new Subject();

	// private _cancelationTokens = new Map<number, boolean>();
	// private _isLongrunning = new Map<number, boolean>();

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor() {
		super("mock-debug.txt");

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);

		this._runtime = new BlitzMaxRuntime();

		// setup event handlers
		this._runtime.on('stopOnEntry', () => {
			this.sendEvent(new StoppedEvent('entry', BlitzMaxDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnStep', () => {
			this.sendEvent(new StoppedEvent('step', BlitzMaxDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnBreakpoint', () => {
			this.sendEvent(new StoppedEvent('breakpoint', BlitzMaxDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnDataBreakpoint', () => {
			this.sendEvent(new StoppedEvent('data breakpoint', BlitzMaxDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnException', () => {
			this.sendEvent(new StoppedEvent('exception', BlitzMaxDebugSession.THREAD_ID));
		});
		this._runtime.on('breakpointValidated', (bp: MockBreakpoint) => {
			this.sendEvent(new BreakpointEvent('changed', <DebugProtocol.Breakpoint>{ verified: bp.verified, id: bp.id }));
		});
		this._runtime.on('output', (text, filePath, line, column) => {
			const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);
			e.body.source = this.createSource(filePath);
			e.body.line = this.convertDebuggerLineToClient(line);
			e.body.column = this.convertDebuggerColumnToClient(column);
			this.sendEvent(e);
		});
		this._runtime.on('end', () => {
			this.sendEvent(new TerminatedEvent());
		});
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		log("initializeRequest ");
		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code to use 'evaluate' when hovering over source
		//response.body.supportsEvaluateForHovers = true;

		// make VS Code to show a 'step back' button
		//response.body.supportsStepBack = false;

		// make VS Code to support data breakpoints
		//response.body.supportsDataBreakpoints = true;

		// make VS Code to support completion in REPL
		//response.body.supportsCompletionsRequest = true;
		//response.body.completionTriggerCharacters = [ ".", "[" ];

		// make VS Code to send cancelRequests
		//response.body.supportsCancelRequest = true;

		// make VS Code send the breakpointLocations request
		//response.body.supportsBreakpointLocationsRequest = false;

		this.sendResponse(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		// wait until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(1000);

		// start the program in the runtime
		this._runtime.start(args.program, !!args.stopOnEntry);

		this.sendResponse(response);
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		/*
		const path = <string>args.source.path;
		const clientLines = args.lines || [];

		// clear all breakpoints for this file
		this._runtime.clearBreakpoints(path);

		// set and verify breakpoint locations
		const actualBreakpoints = clientLines.map(l => {
			let { verified, line, id } = this._runtime.setBreakPoint(path, this.convertClientLineToDebugger(l));
			const bp = <DebugProtocol.Breakpoint> new Breakpoint(verified, this.convertDebuggerLineToClient(line));
			bp.id= id;
			return bp;
		});

		// send back the actual breakpoint positions
		response.body = {
			breakpoints: actualBreakpoints
		};
		this.sendResponse(response);
		*/
	}

	protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): void {
/*
		if (args.source.path) {
			const bps = this._runtime.getBreakpoints(args.source.path, this.convertClientLineToDebugger(args.line));
			response.body = {
				breakpoints: bps.map(col => {
					return {
						line: args.line,
						column: this.convertDebuggerColumnToClient(col)
					}
				})
			};
		} else {
			*/
			response.body = {
				breakpoints: []
			 };
		// }
		this.sendResponse(response);
	}

	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments, request?: DebugProtocol.Request): void {
		this._runtime.pause();
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		// runtime supports no threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(BlitzMaxDebugSession.THREAD_ID, "thread 1")
			]
		};
		this.sendResponse(response);
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {

		const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
		const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
		const endFrame = startFrame + maxLevels;

		const stk = this._runtime.stack(startFrame, endFrame);

		response.body = {
			stackFrames: stk.map(s => new StackFrame(s.index(), s.name(), this.createSource(s.source()), s.source().line, s.source().column)),
			totalFrames: stk.length
		};
		this.sendResponse(response);
	}
/*
	private scopeTypeName(scopeType:VariableScopeType) : string {
		switch (scopeType) {
			case VariableScopeType.LOCAL:
				return "Local";
			case VariableScopeType.GLOBAL:
				return "Global";
			case VariableScopeType.CONST:
				return "Const";
			case VariableScopeType.FIELD:
				return "Field";
			case VariableScopeType.REF:
				return "Self";
		}
		return "n/a";
	}
*/
	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		let scopes : DebugProtocol.Scope[] = [];

		let variableSet = this._runtime.scopes(args.frameId);
		for(let key of Array.from( variableSet.scopedVariables.keys())) {
			if (!key.startsWith("$")) {
				let scopedVariables = variableSet.scopedVariables.get(key);
				if (scopedVariables) {
					scopes.push(new Scope(scopedVariables.scopeType, scopedVariables.ref, false));
				}
			}
		}

		response.body = {
			scopes: scopes
		};
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request) {
log("variablesRequest : " + args.variablesReference);
		let scopedVariables = this._runtime.scopedVariables(args.variablesReference);

		const variables: DebugProtocol.Variable[] = [];

		if (scopedVariables && !scopedVariables.myRef) {
			for (let v of scopedVariables.variables) {
				let attributes:string[] = [];
				switch (v.scopeType) {
					case VariableScopeType.GLOBAL:
						attributes.push("static");
						break;
					case VariableScopeType.CONST:
						attributes.push("readOnly");
						break;
				}

				let ref : number = 0;
				if (v.refId) {
					ref = v.refId;
				}

				let value = "";
				if (ref > 0) {
					value = v.type;
				} else {
					value = v.value ? v.value : "";
				}

				let indexedVariables = v.length;

				let variable : DebugProtocol.Variable = {
					name : v.name,
					value : value,
					variablesReference : ref,
					type : v.type,
					presentationHint : {
						kind : (v.value) ? "property" : "class",
						attributes : attributes
					},
					indexedVariables : indexedVariables
				};

				variables.push(variable);
			}

			response.body = {
				variables: variables
			};
			this.sendResponse(response);
		} else {
			log("wants object for " + args.variablesReference);
			// object dump required
			this._runtime.dump(args.variablesReference, (vars) => {
				for (let v of vars) {
					let attributes:string[] = [];
					switch (v.scopeType) {
						case VariableScopeType.GLOBAL:
							attributes.push("static");
							break;
						case VariableScopeType.CONST:
							attributes.push("readOnly");
							break;
					}

					let ref : number = 0;
					if (v.refId) {
						ref = v.refId;
					}

					let value = "";
					if (ref > 0) {
						value = v.type;
					} else {
						value = v.value ? v.value : "";
					}

					let indexedVariables = v.length;

					let variable : DebugProtocol.Variable = {
						name : v.name,
						value : value,
						variablesReference : ref,
						type : v.type,
						presentationHint : {
							kind : (v.value) ? "property" : "class",
							attributes : attributes
						},
						indexedVariables : indexedVariables
					};

					variables.push(variable);
				}

				response.body = {
					variables: variables
				};
				this.sendResponse(response);
			}, args.start, args.count)
		}


		/*
		if (this._isLongrunning.get(args.variablesReference)) {
			// long running

			if (request) {
				this._cancelationTokens.set(request.seq, false);
			}

			for (let i = 0; i < 100; i++) {
				await timeout(1000);
				variables.push({
					name: `i_${i}`,
					type: "integer",
					value: `${i}`,
					variablesReference: 0
				});
				if (request && this._cancelationTokens.get(request.seq)) {
					break;
				}
			}

			if (request) {
				this._cancelationTokens.delete(request.seq);
			}

		} else {

			const id = this._variableHandles.get(args.variablesReference);

			if (id) {
				variables.push({
					name: id + "_x",
					type: "integer",
					value: "12345",
					variablesReference: 0
				});
				variables.push({
					name: id + "_f",
					type: "float",
					value: "3.14",
					variablesReference: 0
				});
				variables.push({
					name: id + "_s",
					type: "string",
					value: "hello world",
					variablesReference: 0
				});
				variables.push({
					name: id + "_o",
					type: "object",
					value: "Object",
					variablesReference: this._variableHandles.create(id + "_o")
				});

				// cancelation support for long running requests
				const nm = id + "_long_running";
				const ref = this._variableHandles.create(id + "_lr");
				variables.push({
					name: nm,
					type: "object",
					value: "Object",
					variablesReference: ref
				});
				this._isLongrunning.set(ref, true);
			}
		}
		*/
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this._runtime.continue();
		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this._runtime.step(DebugCommand.STEP);
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, request?: DebugProtocol.Request): void {
		this._runtime.step(DebugCommand.STEP_IN);
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request): void {
		this._runtime.step(DebugCommand.STEP_OUT);
		this.sendResponse(response);
	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {

		/*
		let reply: string | undefined = undefined;

		if (args.context === 'repl') {
			// 'evaluate' supports to create and delete breakpoints from the 'repl':
			const matches = /new +([0-9]+)/.exec(args.expression);
			if (matches && matches.length === 2) {
				const mbp = this._runtime.setBreakPoint(this._runtime.sourceFile, this.convertClientLineToDebugger(parseInt(matches[1])));
				const bp = <DebugProtocol.Breakpoint> new Breakpoint(mbp.verified, this.convertDebuggerLineToClient(mbp.line), undefined, this.createSource(this._runtime.sourceFile));
				bp.id= mbp.id;
				this.sendEvent(new BreakpointEvent('new', bp));
				reply = `breakpoint created`;
			} else {
				const matches = /del +([0-9]+)/.exec(args.expression);
				if (matches && matches.length === 2) {
					const mbp = this._runtime.clearBreakPoint(this._runtime.sourceFile, this.convertClientLineToDebugger(parseInt(matches[1])));
					if (mbp) {
						const bp = <DebugProtocol.Breakpoint> new Breakpoint(false);
						bp.id= mbp.id;
						this.sendEvent(new BreakpointEvent('removed', bp));
						reply = `breakpoint deleted`;
					}
				}
			}
		}

		response.body = {
			result: reply ? reply : `evaluate(context: '${args.context}', '${args.expression}')`,
			variablesReference: 0
		};
		this.sendResponse(response);
		*/
	}

	protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): void {

		response.body = {
            dataId: null,
            description: "cannot break on data access",
            accessTypes: undefined,
            canPersist: false
        };

		if (args.variablesReference && args.name) {
			const id = this._variableHandles.get(args.variablesReference);
			if (id.startsWith("global_")) {
				response.body.dataId = args.name;
				response.body.description = args.name;
				response.body.accessTypes = [ "read" ];
				response.body.canPersist = true;
			}
		}

		this.sendResponse(response);
	}

	protected setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments): void {

		// clear all data breakpoints
		this._runtime.clearAllDataBreakpoints();

		response.body = {
			breakpoints: []
		};

		for (let dbp of args.breakpoints) {
			// assume that id is the "address" to break on
			const ok = this._runtime.setDataBreakpoint(dbp.dataId);
			response.body.breakpoints.push({
				verified: ok
			});
		}

		this.sendResponse(response);
	}

	//---- helpers

	private createSource(sourceInfo : MaxSourceInfo): Source {
		return new Source(basename(sourceInfo.path), sourceInfo.path, undefined, undefined, 'bmx-debug-data');
	}
}
