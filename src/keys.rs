/*
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

pub fn commands(mac: bool, code: &str, modifiers: u32) -> crate::cdp::Res<&'static [&'static str]> {
    if mac
        && ((code == "KeyO" && modifiers == 2)
            || (code == "Enter" && matches!(modifiers, 1 | 2 | 9 | 10)))
    {
        return Err("native insertion chord is unsupported; use Enter/Shift+Enter or explicit page eval/CDP".into());
    }
    let commands: &'static [&'static str] = if mac {
        match (modifiers, code) {
            (0, "Backspace") => &["deleteBackward"],
            (0, "Escape") => &["cancelOperation"],
            (0, "ArrowUp") => &["moveUp"],
            (0, "ArrowDown") => &["moveDown"],
            (0, "ArrowLeft") => &["moveLeft"],
            (0, "ArrowRight") => &["moveRight"],
            (0, "Delete") => &["deleteForward"],
            (0, "Home") => &["scrollToBeginningOfDocument"],
            (0, "End") => &["scrollToEndOfDocument"],
            (0, "PageUp") => &["scrollPageUp"],
            (0, "PageDown") => &["scrollPageDown"],
            (8, "Backspace") => &["deleteBackward"],
            (8, "Escape") => &["cancelOperation"],
            (8, "ArrowUp") => &["moveUpAndModifySelection"],
            (8, "ArrowDown") => &["moveDownAndModifySelection"],
            (8, "ArrowLeft") => &["moveLeftAndModifySelection"],
            (8, "ArrowRight") => &["moveRightAndModifySelection"],
            (8, "Delete") => &["deleteForward"],
            (8, "Home") => &["moveToBeginningOfDocumentAndModifySelection"],
            (8, "End") => &["moveToEndOfDocumentAndModifySelection"],
            (8, "PageUp") => &["pageUpAndModifySelection"],
            (8, "PageDown") => &["pageDownAndModifySelection"],
            (2, "Tab") => &["selectNextKeyView"],
            (2, "KeyA") => &["moveToBeginningOfParagraph"],
            (2, "KeyB") => &["moveBackward"],
            (2, "KeyD") => &["deleteForward"],
            (2, "KeyE") => &["moveToEndOfParagraph"],
            (2, "KeyF") => &["moveForward"],
            (2, "KeyH") => &["deleteBackward"],
            (2, "KeyK") => &["deleteToEndOfParagraph"],
            (2, "KeyL") => &["centerSelectionInVisibleArea"],
            (2, "KeyN") => &["moveDown"],
            (2, "KeyP") => &["moveUp"],
            (2, "KeyT") => &["transpose"],
            (2, "KeyV") => &["pageDown"],
            (2, "KeyY") => &["yank"],
            (2, "Backspace") => &["deleteBackwardByDecomposingPreviousCharacter"],
            (2, "ArrowUp") => &["scrollPageUp"],
            (2, "ArrowDown") => &["scrollPageDown"],
            (2, "ArrowLeft") => &["moveToLeftEndOfLine"],
            (2, "ArrowRight") => &["moveToRightEndOfLine"],
            (10, "Tab") => &["selectPreviousKeyView"],
            (10, "KeyA") => &["moveToBeginningOfParagraphAndModifySelection"],
            (10, "KeyB") => &["moveBackwardAndModifySelection"],
            (10, "KeyE") => &["moveToEndOfParagraphAndModifySelection"],
            (10, "KeyF") => &["moveForwardAndModifySelection"],
            (10, "KeyN") => &["moveDownAndModifySelection"],
            (10, "KeyP") => &["moveUpAndModifySelection"],
            (10, "KeyV") => &["pageDownAndModifySelection"],
            (10, "Backspace") => &["deleteBackwardByDecomposingPreviousCharacter"],
            (10, "ArrowUp") => &["scrollPageUp"],
            (10, "ArrowDown") => &["scrollPageDown"],
            (10, "ArrowLeft") => &["moveToLeftEndOfLineAndModifySelection"],
            (10, "ArrowRight") => &["moveToRightEndOfLineAndModifySelection"],
            (1, "Backspace") => &["deleteWordBackward"],
            (1, "Escape") => &["complete"],
            (1, "ArrowUp") => &["moveBackward", "moveToBeginningOfParagraph"],
            (1, "ArrowDown") => &["moveForward", "moveToEndOfParagraph"],
            (1, "ArrowLeft") => &["moveWordLeft"],
            (1, "ArrowRight") => &["moveWordRight"],
            (1, "Delete") => &["deleteWordForward"],
            (1, "PageUp") => &["pageUp"],
            (1, "PageDown") => &["pageDown"],
            (9, "Backspace") => &["deleteWordBackward"],
            (9, "Escape") => &["complete"],
            (9, "ArrowUp") => &["moveParagraphBackwardAndModifySelection"],
            (9, "ArrowDown") => &["moveParagraphForwardAndModifySelection"],
            (9, "ArrowLeft") => &["moveWordLeftAndModifySelection"],
            (9, "ArrowRight") => &["moveWordRightAndModifySelection"],
            (9, "Delete") => &["deleteWordForward"],
            (9, "PageUp") => &["pageUp"],
            (9, "PageDown") => &["pageDown"],
            (3, "KeyB") => &["moveWordBackward"],
            (3, "KeyF") => &["moveWordForward"],
            (3, "Backspace") => &["deleteWordBackward"],
            (11, "KeyB") => &["moveWordBackwardAndModifySelection"],
            (11, "KeyF") => &["moveWordForwardAndModifySelection"],
            (11, "Backspace") => &["deleteWordBackward"],
            (4, "Backspace") => &["deleteToBeginningOfLine"],
            (4, "ArrowUp") => &["moveToBeginningOfDocument"],
            (4, "ArrowDown") => &["moveToEndOfDocument"],
            (4, "ArrowLeft") => &["moveToLeftEndOfLine"],
            (4, "ArrowRight") => &["moveToRightEndOfLine"],
            (12, "Backspace") => &["deleteToBeginningOfLine"],
            (12, "ArrowUp") => &["moveToBeginningOfDocumentAndModifySelection"],
            (12, "ArrowDown") => &["moveToEndOfDocumentAndModifySelection"],
            (12, "ArrowLeft") => &["moveToLeftEndOfLineAndModifySelection"],
            (12, "ArrowRight") => &["moveToRightEndOfLineAndModifySelection"],
            (4, "KeyA") => &["selectAll"],
            (4, "KeyC") => &["copy"],
            (4, "KeyX") => &["cut"],
            (4, "KeyV") => &["paste"],
            (4, "KeyZ") => &["undo"],
            (12, "KeyZ") => &["redo"],
            _ => &[],
        }
    } else {
        match (modifiers, code) {
            (2, "KeyA") => &["selectAll"],
            (2, "KeyC") => &["copy"],
            (2, "KeyX") => &["cut"],
            (2, "KeyV") => &["paste"],
            (2, "KeyZ") => &["undo"],
            (2, "KeyY") | (10, "KeyZ") => &["redo"],
            (10, "KeyV") => &["pasteAndMatchStyle"],
            _ => &[],
        }
    };
    Ok(commands)
}
