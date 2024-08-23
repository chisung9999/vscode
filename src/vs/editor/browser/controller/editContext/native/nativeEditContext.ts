/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FastDomNode } from 'vs/base/browser/fastDomNode';
import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import { ITypeData } from 'vs/editor/browser/controller/editContext/editContext';
import { LineVisibleRanges, RenderingContext } from 'vs/editor/browser/view/renderingContext';
import { ViewController } from 'vs/editor/browser/view/viewController';
import { EditorOption } from 'vs/editor/common/config/editorOptions';
import { OffsetRange } from 'vs/editor/common/core/offsetRange';
import { PositionOffsetTransformer } from 'vs/editor/common/core/positionToOffset';
import { Range } from 'vs/editor/common/core/range';
import { Selection } from 'vs/editor/common/core/selection';
import * as dom from 'vs/base/browser/dom';
import { ViewContext } from 'vs/editor/common/viewModel/viewContext';
import * as viewEvents from 'vs/editor/common/viewEvents';
import { StandardKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { Position } from 'vs/editor/common/core/position';
import { IModelDeltaDecoration } from 'vs/editor/common/model';
import { KeyCode } from 'vs/base/common/keyCodes';
import { DebugEditContext } from 'vs/editor/browser/controller/editContext/native/debugEditContext';
import { ClipboardEventUtils, ClipboardStoredMetadata, CopyOptions, InMemoryClipboardMetadataManager } from 'vs/editor/browser/controller/editContext/textArea/textAreaEditContextInput';
import { IClipboardService } from 'vs/platform/clipboard/common/clipboardService';
import * as browser from 'vs/base/browser/browser';
import * as platform from 'vs/base/common/platform';

// Boolean which controls whether we should show the control, selection and character bounds
const showControlBounds = true;

export class NativeEditContext extends Disposable {

	// HTML Elements
	private _parent: HTMLElement | undefined;

	// Edit Context API
	private readonly _editContext: EditContext;
	private _selectionOfEditContextText: Range | undefined;

	// Composition
	private _compositionStartPosition: Position | undefined;
	private _compositionEndPosition: Position | undefined;

	private _renderingContext: RenderingContext | undefined;
	private _rangeStart: number = 0;

	private _linesVisibleRanges: LineVisibleRanges[] | null = null;

	private _decorations: string[] = [];

	private _previousState: {
		value: string;
		selectionStart: number;
		selectionEnd: number;
		selectionOfContent: Selection;
	} | undefined;
	private _currentState: {
		value: string;
		selectionStart: number;
		selectionEnd: number;
		selectionOfContent: Selection;
	} | undefined;

	private _modelSelections = [new Selection(1, 1, 1, 1)];
	private _emptySelectionClipboard: boolean;
	private _copyWithSyntaxHighlighting: boolean;

	constructor(
		public readonly domElement: FastDomNode<HTMLDivElement>,
		private readonly _context: ViewContext,
		private readonly _viewController: ViewController,
		@IClipboardService clipboardService: IClipboardService
	) {
		super();
		const domNode = this.domElement.domNode;
		this._editContext = this.domElement.domNode.editContext = showControlBounds ? new DebugEditContext() : new EditContext();

		const options = this._context.configuration.options;
		this._emptySelectionClipboard = options.get(EditorOption.emptySelectionClipboard);
		this._copyWithSyntaxHighlighting = options.get(EditorOption.copyWithSyntaxHighlighting);

		this._register(dom.addDisposableListener(domNode, 'keydown', (e) => {

			console.log('keydown : ', e);

			const standardKeyboardEvent = new StandardKeyboardEvent(e);

			console.log('standardKeyboardEvent : ', standardKeyboardEvent);
			console.log('standardKeyboardEvent.keyCode === KeyCode.KEY_IN_COMPOSITION : ', standardKeyboardEvent.keyCode === KeyCode.KEY_IN_COMPOSITION);
			console.log('this._editContext : ', this._editContext);
			console.log('this.domElement.domNode.textContent ; ', this.domElement.domNode.textContent);

			// When the IME is visible, the keys, like arrow-left and arrow-right, should be used to navigate in the IME, and should not be propagated further
			// Seems like can't do more specific than that because when in composition, left and right are not in keycode
			if (standardKeyboardEvent.keyCode === KeyCode.KEY_IN_COMPOSITION) { // (this._currentComposition && standardKeyboardEvent.keyCode === KeyCode.Backspace)
				console.log('stopping the propagation');
				// Stop propagation for keyDown events if the IME is processing key input
				standardKeyboardEvent.stopPropagation();
			} else if (standardKeyboardEvent.keyCode === KeyCode.Enter) {
				console.log('enter key pressed');
				this.addNewLine();
			}
			this._viewController.emitKeyDown(standardKeyboardEvent);
		}));
		this._register(dom.addDisposableListener(domNode, 'keyup', (e) => {
			this._viewController.emitKeyUp(new StandardKeyboardEvent(e));
		}));
		this._register(editContextAddDisposableListener(this._editContext, 'textupdate', e => {
			this._updateText(e);
		}));
		this._register(editContextAddDisposableListener(this._editContext, 'compositionstart', e => {
			this._updateCompositionStartPosition();
			this._viewController.compositionStart();
			this._context.viewModel.onCompositionStart();
		}));

		this._register(editContextAddDisposableListener(this._editContext, 'compositionend', e => {

			console.log('oncompositionend : ', e);
			this._updateCompositionEndPosition();
			this._viewController.compositionEnd();
			this._context.viewModel.onCompositionEnd();
		}));
		this._register(editContextAddDisposableListener(this._editContext, 'textformatupdate', e => {
			this._handleTextFormatUpdate(e);
		}));
		this._register(editContextAddDisposableListener(this._editContext, 'characterboundsupdate', e => {
			console.log('characterboundsupdate : ', e);
			this._rangeStart = e.rangeStart;
			this._updateCharacterBounds(e.rangeStart);
		}));


		/*
		// https://issues.chromium.org/issues/40642681
		// As soon as the edit context is sent the paste event is not fired and pasting no longer pastes into the content editable
		// Copy however still works
		EditContext: disable dom mutation for Paste as plain text
		This CL disables DOM mutation for Paste as plain text.
		The corresponding test, ctrl+shift+v, is also added.

		document.execCommand and related commands (queryCommandValue,
		queryCommandState, queryCommandEnabled, queryCommandIndeterm) do not
		work in a way that makes sense with EditContext. They do not fire
		beforeinput, which EditContext depends on, and they modify the DOM
		directly rather than going through EditContext, which will cause the
		editor view implemented in the DOM to become out of sync with the
		editor model whose state is in the EditContext.

		Furthermore execCommand is deprecated and non-interoperable in many
		cases.

		Given these factors, in this CL make execCommand a no-op when
		an EditContext-based Editing Host has focus, and make all the
		related query commands return false/null values. This change is
		limited to command types that are conditionally enabled based on
		whether an Editing Host has focus. Command types that are
		unconditionally enabled (such as "copy") are not affected.
		*/

		this._register(dom.addDisposableListener(domElement.domNode, 'copy', (e) => {
			console.log('copy : ', e);

			const clipboardStoredMetada = this._getDataToCopy();
			const storedMetadata: ClipboardStoredMetadata = {
				version: 1,
				isFromEmptySelection: clipboardStoredMetada.isFromEmptySelection,
				multicursorText: clipboardStoredMetada.multicursorText,
				mode: clipboardStoredMetada.mode
			};
			InMemoryClipboardMetadataManager.INSTANCE.set(
				// When writing "LINE\r\n" to the clipboard and then pasting,
				// Firefox pastes "LINE\n", so let's work around this quirk
				(browser.isFirefox ? clipboardStoredMetada.text.replace(/\r\n/g, '\n') : clipboardStoredMetada.text),
				storedMetadata
			);
			e.preventDefault();
			if (e.clipboardData) {
				ClipboardEventUtils.setTextData(e.clipboardData, clipboardStoredMetada.text, clipboardStoredMetada.html, storedMetadata);
			}
		}));
		this._register(dom.addDisposableListener(domElement.domNode, 'keydown', async (e) => {

			console.log('inside of keydown of screen reader content');

			const clipboardText = await clipboardService.readText();
			console.log('clipboardText : ', clipboardText);
			const standardKeyboardEvent = new StandardKeyboardEvent(e);
			// For the paste event
			if (standardKeyboardEvent.metaKey && standardKeyboardEvent.keyCode === KeyCode.KeyV) {
				e.preventDefault();

				const clipboardText = await clipboardService.readText();
				if (clipboardText !== '') {
					const metadata = InMemoryClipboardMetadataManager.INSTANCE.get(clipboardText);
					let pasteOnNewLine = false;
					let multicursorText: string[] | null = null;
					let mode: string | null = null;
					if (metadata) {
						pasteOnNewLine = (this._context.configuration.options.get(EditorOption.emptySelectionClipboard) && !!metadata.isFromEmptySelection);
						multicursorText = (typeof metadata.multicursorText !== 'undefined' ? metadata.multicursorText : null);
						mode = metadata.mode;
					}
					_viewController.paste(clipboardText, pasteOnNewLine, multicursorText, mode);
				}
			}
			// if (standardKeyboardEvent.metaKey && standardKeyboardEvent.keyCode === KeyCode.KeyX) {
			// 	clipboardStoredMetada = this._getDataToCopy();
			// 	viewController.cut();
			// }
		}));
	}

	public override dispose(): void {
		super.dispose();
	}

	private addNewLine(): void {
		const textAfterAddingNewLine = this._editContext.text.substring(0, this._editContext.selectionStart) + '\n' + this._editContext.text.substring(this._editContext.selectionEnd);
		this._editContext.updateText(0, Number.MAX_SAFE_INTEGER, textAfterAddingNewLine);

		const typeInput: ITypeData = {
			text: '\n',
			replacePrevCharCnt: 0,
			replaceNextCharCnt: 0,
			positionDelta: 0,
		};

		this._updateCompositionEndPosition();
		console.log('typeInput : ', typeInput);
		this._onType(typeInput);
	}

	private _updateText(e: { text: string; updateRangeStart: number; updateRangeEnd: number }) {
		console.log('textupdate : ', e);
		console.log('e.text : ', e.text);
		console.log('e.updateRangeStart : ', e.updateRangeStart);
		console.log('e.updateRangeEnd : ', e.updateRangeEnd);
		console.log('this._editContext.text : ', this._editContext.text);
		console.log('this._editContext.selectionStart : ', this._editContext.selectionStart);
		console.log('this._editContext.selectionEnd : ', this._editContext.selectionEnd);

		console.log('this._currentState : ', this._currentState);
		console.log('this._previousState : ', this._previousState);
		console.log('this._context.viewModel.model.getValue() : ', this._context.viewModel.model.getValue());

		if (!this._previousState) {
			return;
		}

		/**
		 * deduce input from the data above
		 */
		const previousSelectionStart = this._previousState.selectionStart;
		const previousSelectionEnd = this._previousState.selectionEnd;

		let replacePrevCharCnt = 0;
		if (e.updateRangeStart < previousSelectionStart) {
			replacePrevCharCnt = previousSelectionStart - e.updateRangeStart;
		}

		let replaceNextCharCnt = 0;
		if (e.updateRangeEnd > previousSelectionEnd) {
			replaceNextCharCnt = e.updateRangeEnd - previousSelectionEnd;
		}

		const data = e.text.replaceAll(/[^\S\r\n]/gmu, ' ');
		const typeInput: ITypeData = {
			text: data,
			replacePrevCharCnt,
			replaceNextCharCnt,
			positionDelta: 0,
		};

		this._updateCompositionEndPosition();
		console.log('typeInput : ', typeInput);
		this._onType(typeInput);
		console.log('this._context.viewModel.model.getValue() : ', this._context.viewModel.model.getValue());
		console.log('end of text update');
	}

	public writeEditContextContent(): void {

		console.log('writeEditContextContent');

		if (this._previousState) {
			this._previousState = this._currentState;
		}
		this._currentState = this._getEditContextState();
		if (!this._previousState) {
			this._previousState = this._currentState;
		}
		this._selectionOfEditContextText = this._currentState.selectionOfContent;
		this._editContext.updateText(0, Number.MAX_SAFE_INTEGER, this._currentState.value);
		this._editContext.updateSelection(this._currentState.selectionStart, this._currentState.selectionEnd);

		console.log('this._context.viewModel.model.getValue() : ', this._context.viewModel.model.getValue());
		console.log('editContextState : ', this._currentState);
		console.log('this._editContext.text : ', this._editContext.text);
		console.log('editContextState.selectionStart : ', this._currentState.selectionStart);
		console.log('editContextState.selectionEnd : ', this._currentState.selectionEnd);
		console.log('this._selectionOfEditContextText : ', this._selectionOfEditContextText);
	}

	public setRenderingContext(renderingContext: RenderingContext): void {
		this._renderingContext = renderingContext;
	}

	// -- need to use this in composition
	public onCursorStateChanged(e: viewEvents.ViewCursorStateChangedEvent): boolean {
		console.log('onCursorStateChanged');
		// We must update the <textarea> synchronously, otherwise long press IME on macos breaks.
		// See https://github.com/microsoft/vscode/issues/165821
		this._modelSelections = e.modelSelections.slice(0);
		this.writeEditContextContent();
		this._updateBounds();
		return true;
	}

	public onConfigurationChanged(e: viewEvents.ViewConfigurationChangedEvent): boolean {
		const options = this._context.configuration.options;
		this._emptySelectionClipboard = options.get(EditorOption.emptySelectionClipboard);
		this._copyWithSyntaxHighlighting = options.get(EditorOption.copyWithSyntaxHighlighting);
		return true;
	}

	// -- need to use this in composition
	public onScrollChanged(e: viewEvents.ViewScrollChangedEvent): boolean {
		this._updateBounds();
		return true;
	}

	public setParent(parent: HTMLElement): void {
		this._parent = parent;
	}

	// --- end event handlers

	private _onType(typeInput: ITypeData): void {
		console.log('_onType');
		if (typeInput.replacePrevCharCnt || typeInput.replaceNextCharCnt || typeInput.positionDelta) {
			console.log('before composition type');
			this._viewController.compositionType(typeInput.text, typeInput.replacePrevCharCnt, typeInput.replaceNextCharCnt, typeInput.positionDelta);
		} else {
			this._viewController.type(typeInput.text);
		}
	}

	public _getEditContextState(): {
		value: string;
		selectionStart: number;
		selectionEnd: number;
		selectionOfContent: Selection;
	} {
		console.log('_getEditContextState');

		const cursorState = this._context.viewModel.getPrimaryCursorState().modelState;
		const cursorSelection = cursorState.selection;
		let value = '';
		let selectionStart: number = 0;
		let selectionEnd: number = 0;
		for (let i = cursorSelection.startLineNumber; i <= cursorSelection.endLineNumber; i++) {
			value += this._context.viewModel.getLineContent(i);
			if (i === cursorSelection.startLineNumber) {
				selectionStart = cursorSelection.startColumn - 1;
			}
			if (i === cursorSelection.endLineNumber) {
				selectionEnd += cursorSelection.endColumn - 1;
			} else {
				selectionEnd += this._context.viewModel.getLineMaxColumn(i) - 1;
			}
		}
		const selectionOfContent = new Selection(cursorSelection.startLineNumber, 1, cursorSelection.endLineNumber, this._context.viewModel.getLineMaxColumn(cursorSelection.endLineNumber));
		return {
			value,
			selectionStart,
			selectionEnd,
			selectionOfContent,
		};
	}

	private _updateCharacterBounds(rangeStart: number) {

		console.log('_updateCharacterBounds');
		console.log('rangeStart : ', rangeStart);
		console.log('this._parent : ', this._parent);
		console.log('this._compositionStartPosition : ', this._compositionStartPosition);
		console.log('this._compositionEndPosition : ', this._compositionEndPosition);

		if (!this._parent || !this._compositionStartPosition || !this._compositionEndPosition) {
			console.log('early return of _updateCharacterBounds');
			return;
		}

		const options = this._context.configuration.options;
		const lineHeight = options.get(EditorOption.lineHeight);
		const contentLeft = options.get(EditorOption.layoutInfo).contentLeft;
		const typicalHalfwidthCharacterWidth = options.get(EditorOption.fontInfo).typicalHalfwidthCharacterWidth;
		const parentBounds = this._parent.getBoundingClientRect();
		const verticalOffsetStart = this._context.viewLayout.getVerticalOffsetForLineNumber(this._compositionStartPosition.lineNumber);
		let left: number = parentBounds.left + contentLeft;
		let width: number = typicalHalfwidthCharacterWidth / 2;

		console.log('before using this rendering context');
		console.log('this._renderingContext : ', this._renderingContext);

		if (this._renderingContext) {
			const range = Range.fromPositions(this._compositionStartPosition, this._compositionEndPosition);
			this._linesVisibleRanges = this._renderingContext.linesVisibleRangesForRange(range, true, true) ?? this._linesVisibleRanges;

			console.log('range : ', range);
			console.log('linesVisibleRanges : ', this._linesVisibleRanges);
			this._linesVisibleRanges?.forEach(visibleRange => {
				console.log('visibleRange : ', visibleRange);
				console.log(visibleRange.ranges.forEach(r => {
					console.log('r : ', r);
				}));
			});

			if (!this._linesVisibleRanges || this._linesVisibleRanges.length === 0) { return; }

			const minLeft = Math.min(...this._linesVisibleRanges.map(r => Math.min(...r.ranges.map(r => r.left))));
			const maxLeft = Math.max(...this._linesVisibleRanges.map(r => Math.max(...r.ranges.map(r => r.left + r.width))));
			left += minLeft;
			width = maxLeft - minLeft;
		}

		console.log('before setting characterBounds');

		const characterBounds = [new DOMRect(
			left,
			parentBounds.top + verticalOffsetStart - this._context.viewLayout.getCurrentScrollTop(),
			width,
			lineHeight,
		)];

		console.log('characterBounds[0] : ', characterBounds[0]);
		this._editContext.updateCharacterBounds(rangeStart, characterBounds);
	}

	private _handleTextFormatUpdate(e: TextFormatUpdateEvent): void {

		const selectionOfEditText = this._selectionOfEditContextText;
		if (!selectionOfEditText) {
			return;
		}

		const formats = e.getTextFormats();

		console.log('_handleTextFormatUpdate');
		console.log('e : ', e);
		console.log('formats : ', formats);

		const decorations: IModelDeltaDecoration[] = [];
		formats.forEach(f => {
			const offsetRange = new OffsetRange(f.rangeStart, f.rangeEnd);
			const textPositionTransformer = new PositionOffsetTransformer(this._editContext.text);
			const range = textPositionTransformer.getRange(offsetRange);

			console.log('range : ', range);

			const startLineNumber = selectionOfEditText.startLineNumber + range.startLineNumber - 1;
			const endLineNumber = selectionOfEditText.startLineNumber + range.endLineNumber - 1;
			let startColumn: number;
			console.log('this._selectionOfEditContextText.startColumn : ', selectionOfEditText.startColumn);
			if (startLineNumber === selectionOfEditText.startLineNumber) {
				startColumn = selectionOfEditText.startColumn + range.startColumn - 1;
			} else {
				startColumn = range.startColumn;
			}
			let endColumn: number;
			if (endLineNumber === selectionOfEditText.startLineNumber) {
				endColumn = selectionOfEditText.startColumn + range.endColumn - 1;
			} else {
				endColumn = range.endColumn;
			}
			const decorationRange = new Range(startLineNumber, startColumn, endLineNumber, endColumn);

			console.log('decorationRange : ', decorationRange);

			const classNames = [
				'ime',
				`underline-style-${f.underlineStyle.toLowerCase()}`,
				`underline-thickness-${f.underlineThickness.toLowerCase()}`,
			];
			// Need to tset the correct range. Range currently not correct because of this._selectionOfEditContextText, need to correctly update it.
			decorations.push({
				range: decorationRange,
				options: {
					description: 'textFormatDecoration',
					inlineClassName: classNames.join(' '),
				}
			});
		});

		console.log('decorations : ', decorations);

		this._decorations = this._context.viewModel.model.deltaDecorations(this._decorations, decorations);
	}

	private _updateBounds() {
		this._updateSelectionAndControlBounds();
		this._updateCharacterBounds(this._rangeStart);
	}

	private _updateSelectionAndControlBounds() {

		console.log('_updateBounds');

		if (!this._parent) {
			return;
		}
		const primaryViewState = this._context.viewModel.getCursorStates()[0].viewState;
		const primarySelection = primaryViewState.selection;
		const parentBounds = this._parent.getBoundingClientRect();
		const verticalOffsetStart = this._context.viewLayout.getVerticalOffsetForLineNumber(primarySelection.startLineNumber);
		const options = this._context.configuration.options;
		const lineHeight = options.get(EditorOption.lineHeight);
		const contentLeft = options.get(EditorOption.layoutInfo).contentLeft;

		let selectionBounds: DOMRect;
		let controlBounds: DOMRect;
		if (primarySelection.isEmpty()) {
			const typicalHalfwidthCharacterWidth = options.get(EditorOption.fontInfo).typicalHalfwidthCharacterWidth;
			let left: number = parentBounds.left + contentLeft;
			if (this._renderingContext) {
				const linesVisibleRanges = this._renderingContext.linesVisibleRangesForRange(primaryViewState.selection, true, true) ?? [];
				console.log('linesVisibleRanges : ', linesVisibleRanges);
				if (linesVisibleRanges.length === 0) { return; }
				const minLeft = Math.min(...linesVisibleRanges.map(r => Math.min(...r.ranges.map(r => r.left))));
				left += (minLeft + typicalHalfwidthCharacterWidth / 2);
			}
			selectionBounds = new DOMRect(
				left,
				parentBounds.top + verticalOffsetStart - this._context.viewLayout.getCurrentScrollTop(),
				typicalHalfwidthCharacterWidth / 2,
				lineHeight,
			);
			controlBounds = selectionBounds;
		} else {
			const numberOfLines = primarySelection.endLineNumber - primarySelection.startLineNumber;
			selectionBounds = new DOMRect(
				parentBounds.left + contentLeft,
				parentBounds.top + verticalOffsetStart - this._context.viewLayout.getCurrentScrollTop(),
				parentBounds.width - contentLeft,
				(numberOfLines + 1) * lineHeight,
			);
			controlBounds = selectionBounds;
		}

		console.log('selectionBounds : ', selectionBounds);
		console.log('controlBounds : ', controlBounds);

		this._editContext.updateControlBounds(controlBounds);
		this._editContext.updateSelectionBounds(selectionBounds);
	}

	private _updateCompositionEndPosition(): void {
		this._compositionEndPosition = this._context.viewModel.getCursorStates()[0].viewState.position;
	}

	private _updateCompositionStartPosition(): void {
		this._compositionStartPosition = this._context.viewModel.getCursorStates()[0].viewState.position;
	}

	private _getDataToCopy() {
		const rawTextToCopy = this._context.viewModel.getPlainTextToCopy(this._modelSelections, this._emptySelectionClipboard, platform.isWindows);
		const newLineCharacter = this._context.viewModel.model.getEOL();

		const isFromEmptySelection = (this._emptySelectionClipboard && this._modelSelections.length === 1 && this._modelSelections[0].isEmpty());
		const multicursorText = (Array.isArray(rawTextToCopy) ? rawTextToCopy : null);
		const text = (Array.isArray(rawTextToCopy) ? rawTextToCopy.join(newLineCharacter) : rawTextToCopy);

		let html: string | null | undefined = undefined;
		let mode: string | null = null;
		if (CopyOptions.forceCopyWithSyntaxHighlighting || (this._copyWithSyntaxHighlighting && text.length < 65536)) {
			const richText = this._context.viewModel.getRichTextToCopy(this._modelSelections, this._emptySelectionClipboard);
			if (richText) {
				html = richText.html;
				mode = richText.mode;
			}
		}
		return {
			isFromEmptySelection,
			multicursorText,
			text,
			html,
			mode
		};
	}
}

function editContextAddDisposableListener<K extends keyof EditContextEventHandlersEventMap>(target: EventTarget, type: K, listener: (this: GlobalEventHandlers, ev: EditContextEventHandlersEventMap[K]) => any, options?: boolean | AddEventListenerOptions): IDisposable {
	target.addEventListener(type, listener as any, options);
	return {
		dispose() {
			target.removeEventListener(type, listener as any);
		}
	};
}
