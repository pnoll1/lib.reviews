/* global $ */

const {
  wrapItem,
  blockTypeItem,
  Dropdown,
  DropdownSubmenu,
  joinUpItem,
  liftItem,
  undoItem,
  redoItem,
  icons,
  MenuItem
} = require("prosemirror-menu");

// Load proper translations for built-in items
undoItem.spec.title = msg('undo');
redoItem.spec.title = msg('redo');
joinUpItem.spec.title = msg('join with item above');
liftItem.spec.title = msg('decrease item indentation');

// Tables not supported for now
//
// const {
//   createTable,
//   addColumnBefore,
//   addColumnAfter,
//   removeColumn,
//   addRowBefore,
//   addRowAfter,
//   removeRow
// } = require("prosemirror-schema-table");
const { NodeSelection } = require("prosemirror-state");
const { toggleMark } = require("prosemirror-commands");
const { wrapInList } = require("prosemirror-schema-list");
const { TextField, openPrompt } = require("./editor-prompt");


// Helpers to create specific types of items

function canInsert(state, nodeType, attrs) {
  let $from = state.selection.$from;
  for (let d = $from.depth; d >= 0; d--) {
    let index = $from.index(d);
    if ($from.node(d).canReplaceWith(index, index, nodeType, attrs))
      return true;
  }
  return false;
}

function insertImageItem(nodeType) {
  return new MenuItem({
    title: msg('insert image help'),
    label: msg('insert image'),
    select(state) {
      return canInsert(state, nodeType);
    },
    run(state, _, view) {
      let { from, to } = state.selection,
        attrs = null;
      if (state.selection instanceof NodeSelection && state.selection.node.type == nodeType)
        attrs = state.selection.node.attrs;
      openPrompt({
        rteContainer: $(view.dom).parent().parent()[0],
        title: msg('insert image dialog title'),
        fields: {
          src: new TextField({ label: msg('image url'), required: true, value: attrs && attrs.src }),
          alt: new TextField({
            label: msg('image alt text'),
            value: attrs ? attrs.title : state.doc.textBetween(from, to, " ")
          })
        },
        callback(attrs) {
          view.dispatch(view.state.tr.replaceSelectionWith(nodeType.createAndFill(attrs)));
          view.focus();
        }
      });
    }
  });
}

// function positiveInteger(value) {
//   if (!/^[1-9]\d*$/.test(value))
//     return "Should be a positive integer";
// }
//
// function insertTableItem(tableType) {
//   return new MenuItem({
//     title: "Insert a table",
//     run(_, _a, view) {
//       openPrompt({
//         title: "Insert table",
//         fields: {
//           rows: new TextField({ label: "Rows", validate: positiveInteger }),
//           cols: new TextField({ label: "Columns", validate: positiveInteger })
//         },
//         callback({ rows, cols }) {
//           let tr = view.state.tr.replaceSelectionWith(createTable(tableType, +rows, +cols));
//           tr.setSelection(Selection.near(tr.doc.resolve(view.state.selection.from)));
//           view.dispatch(tr.scrollIntoView());
//           view.focus();
//         }
//       });
//     },
//     select(state) {
//       let $from = state.selection.$from;
//       for (let d = $from.depth; d >= 0; d--) {
//         let index = $from.index(d);
//         if ($from.node(d).canReplaceWith(index, index, tableType))
//           return true;
//       }
//       return false;
//     },
//     label: "Table"
//   });
// }

function cmdItem(cmd, options) {
  let passedOptions = {
    label: options.title,
    run: cmd,
    select(state) {
      return cmd(state);
    }
  };
  for (let prop in options)
    passedOptions[prop] = options[prop];
  return new MenuItem(passedOptions);
}

function markActive(state, type) {
  let { from, $from, to, empty } = state.selection;
  if (empty)
    return type.isInSet(state.storedMarks || $from.marks());
  else
    return state.doc.rangeHasMark(from, to, type);
}

function markItem(markType, options) {
  let passedOptions = {
    active(state) {
      return markActive(state, markType);
    }
  };
  for (let prop in options)
    passedOptions[prop] = options[prop];
  return cmdItem(toggleMark(markType), passedOptions);
}

function linkItem(markType) {
  return new MenuItem({
    title: msg('add or remove link'),
    icon: icons.link,
    active(state) {
      return markActive(state, markType);
    },
    select(state) {
      return !state.selection.empty;
    },
    onDeselected: "disable",
    run(state, dispatch, view) {
      if (markActive(state, markType)) {
        toggleMark(markType)(state, dispatch);
        return true;
      }
      openPrompt({
        rteContainer: $(view.dom).parent().parent()[0],
        title: msg('add link dialog title'),
        fields: {
          href: new TextField({
            label: msg('web address'),
            required: true,
            clean: (val) => {
              if (!/^https?:\/\//i.test(val))
                val = 'http://' + val;
              return val;
            }
          })
        },
        callback(attrs) {
          toggleMark(markType, attrs)(view.state, view.dispatch);
          view.focus();
        }
      });
    }
  });
}

function wrapListItem(nodeType, options) {
  return cmdItem(wrapInList(nodeType, options.attrs), options);
}

// :: (Schema) → Object
// Given a schema, look for default mark and node types in it and
// return an object with relevant menu items relating to those marks:
//
// **`toggleStrong`**`: MenuItem`
//   : A menu item to toggle the [strong mark](#schema-basic.StrongMark).
//
// **`toggleEm`**`: MenuItem`
//   : A menu item to toggle the [emphasis mark](#schema-basic.EmMark).
//
// **`toggleCode`**`: MenuItem`
//   : A menu item to toggle the [code font mark](#schema-basic.CodeMark).
//
// **`toggleLink`**`: MenuItem`
//   : A menu item to toggle the [link mark](#schema-basic.LinkMark).
//
// **`insertImage`**`: MenuItem`
//   : A menu item to insert an [image](#schema-basic.Image).
//
// **`wrapBulletList`**`: MenuItem`
//   : A menu item to wrap the selection in a [bullet list](#schema-list.BulletList).
//
// **`wrapOrderedList`**`: MenuItem`
//   : A menu item to wrap the selection in an [ordered list](#schema-list.OrderedList).
//
// **`wrapBlockQuote`**`: MenuItem`
//   : A menu item to wrap the selection in a [block quote](#schema-basic.BlockQuote).
//
// **`makeParagraph`**`: MenuItem`
//   : A menu item to set the current textblock to be a normal
//     [paragraph](#schema-basic.Paragraph).
//
// **`makeCodeBlock`**`: MenuItem`
//   : A menu item to set the current textblock to be a
//     [code block](#schema-basic.CodeBlock).
//
// **`insertTable`**`: MenuItem`
//   : An item to insert a [table](#schema-table).
//
// **`addRowBefore`**, **`addRowAfter`**, **`removeRow`**, **`addColumnBefore`**, **`addColumnAfter`**, **`removeColumn`**`: MenuItem`
//   : Table-manipulation items.
//
// **`makeHead[N]`**`: MenuItem`
//   : Where _N_ is 1 to 6. Menu items to set the current textblock to
//     be a [heading](#schema-basic.Heading) of level _N_.
//
// **`insertHorizontalRule`**`: MenuItem`
//   : A menu item to insert a horizontal rule.
//
// The return value also contains some prefabricated menu elements and
// menus, that you can use instead of composing your own menu from
// scratch:
//
// **`insertMenu`**`: Dropdown`
//   : A dropdown containing the `insertImage` and
//     `insertHorizontalRule` items.
//
// **`typeMenu`**`: Dropdown`
//   : A dropdown containing the items for making the current
//     textblock a paragraph, code block, or heading.
//
// **`fullMenu`**`: [[MenuElement]]`
//   : An array of arrays of menu elements for use as the full menu
//     for, for example the [menu bar](https://github.com/prosemirror/prosemirror-menu#user-content-menubar).
function buildMenuItems(schema) {
  /* eslint no-cond-assign: "off" */

  let r = {},
    type;
  if (type = schema.marks.strong)
    r.toggleStrong = markItem(type, { title: msg('toggle bold'), icon: icons.strong });
  if (type = schema.marks.em)
    r.toggleEm = markItem(type, { title: msg('toggle italic'), icon: icons.em });
  if (type = schema.marks.code)
    r.toggleCode = markItem(type, { title: msg('toggle code'), icon: icons.code });
  if (type = schema.marks.link)
    r.toggleLink = linkItem(type);

  if (type = schema.nodes.image)
    r.insertImage = insertImageItem(type);
  if (type = schema.nodes.bullet_list)
    r.wrapBulletList = wrapListItem(type, {
      title: msg('format as bullet list'),
      icon: icons.bulletList
    });
  if (type = schema.nodes.ordered_list)
    r.wrapOrderedList = wrapListItem(type, {
      title: msg('format as numbered list'),
      icon: icons.orderedList
    });
  if (type = schema.nodes.blockquote)
    r.wrapBlockQuote = wrapItem(type, {
      title: msg('format as quote'),
      icon: icons.blockquote
    });
  if (type = schema.nodes.paragraph)
    r.makeParagraph = blockTypeItem(type, {
      title: msg('format as paragraph help'),
      label: msg('format as paragraph')
    });
  if (type = schema.nodes.code_block)
    r.makeCodeBlock = blockTypeItem(type, {
      title: msg('format as code block help'),
      label: msg('format as code block')
    });
  if (type = schema.nodes.heading)
    for (let i = 1; i <= 10; i++)
      r["makeHead" + i] = blockTypeItem(type, {
        title: msg('format as level heading help').replace('%d', i),
        label: msg('format as level heading').replace('%d', i),
        attrs: { level: i }
      });
  if (type = schema.nodes.horizontal_rule) {
    let hr = type;
    r.insertHorizontalRule = new MenuItem({
      title: msg('insert horizontal rule help'),
      label: msg('insert horizontal rule'),
      select(state) {
        return canInsert(state, hr);
      },
      run(state, dispatch) {
        dispatch(state.tr.replaceSelectionWith(hr.create()));
      }
    });
  }
  // if (type = schema.nodes.table)
  //   r.insertTable = insertTableItem(type);
  // if (type = schema.nodes.table_row) {
  //   r.addRowBefore = cmdItem(addRowBefore, { title: "Add row before" });
  //   r.addRowAfter = cmdItem(addRowAfter, { title: "Add row after" });
  //   r.removeRow = cmdItem(removeRow, { title: "Remove row" });
  //   r.addColumnBefore = cmdItem(addColumnBefore, { title: "Add column before" });
  //   r.addColumnAfter = cmdItem(addColumnAfter, { title: "Add column after" });
  //   r.removeColumn = cmdItem(removeColumn, { title: "Remove column" });
  // }

  let cut = arr => arr.filter(x => x);
  r.insertMenu = new Dropdown(cut([r.insertImage, r.insertHorizontalRule, r.insertTable]), {
    label: msg('insert'),
    title: msg('insert help')
  });
  r.typeMenu = new Dropdown(cut([r.makeParagraph, r.makeCodeBlock, r.makeHead1 && new DropdownSubmenu(cut([
    r.makeHead1, r.makeHead2, r.makeHead3, r.makeHead4, r.makeHead5, r.makeHead6
  ]), { label: msg('format as heading') })]), { label: msg('format block'), title: msg('format block help') });
  // let tableItems = cut([r.addRowBefore, r.addRowAfter, r.removeRow, r.addColumnBefore, r.addColumnAfter, r.removeColumn]);
  // if (tableItems.length)
  //   r.tableMenu = new Dropdown(tableItems, { label: "Table" });

  r.inlineMenu = [cut([r.toggleStrong, r.toggleEm, r.toggleCode, r.toggleLink]), [r.insertMenu]];
  r.blockMenu = [cut([r.typeMenu, r.tableMenu, r.wrapBulletList, r.wrapOrderedList, r.wrapBlockQuote, joinUpItem,
    liftItem
  ])];
  r.fullMenu = r.inlineMenu.concat(r.blockMenu).concat([
    [undoItem, redoItem]
  ]);

  return r;
}

function msg(key) {
  if (window.config && window.config.messages && window.config.messages[key])
    return window.config.messages[key];
  else
    return '?' + key + '?';
}

exports.buildMenuItems = buildMenuItems;