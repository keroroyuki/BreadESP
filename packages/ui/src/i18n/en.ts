// i18n dictionary — English (source of truth for the key set).
// Flat dot-namespaced keys: `Record<MessageKey, string>` on the zh side makes
// a missing/extra translation a compile error. Keys are added per-stage as
// components migrate; T5.1 completes the sweep.
export const en = {
  // common
  'common.ok': 'OK',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.delete': 'Delete',
  'common.undo': 'Undo',
  'common.redo': 'Redo',
  'common.busy': 'Working…',

  // simulation status (SimStatus union)
  'sim.status.idle': 'idle',
  'sim.status.loaded': 'loaded',
  'sim.status.running': 'running',
  'sim.status.paused': 'paused',
  'sim.status.stopped': 'stopped',
  'sim.status.error': 'error',

  // toolbar
  'toolbar.new': 'New',
  'toolbar.open': 'Open',
  'toolbar.save': 'Save',
  'toolbar.saveAs': 'Save as',
  'toolbar.close': 'Close',
  'toolbar.pause': 'Pause',
  'toolbar.resume': 'Resume',
  'toolbar.reset': 'Reset',
  'toolbar.speed': 'speed',
  'toolbar.dirPlaceholder': 'project directory (.breadesp)',
  'toolbar.noProject': 'no project open',
  'toolbar.project': 'project: {dir}',

  // toasts
  'toast.newOk': 'Project created.',
  'toast.openOk': 'Project opened.',
  'toast.openFailed': 'Open failed: {detail}',
  'toast.saveOk': 'Project saved.',
  'toast.saveFailed': 'Save failed: {detail}',
  'toast.saveAsOk': 'Project saved.',
  'toast.saveAsFailed': 'Save as failed: {detail}',
  'toast.saveNoProject': 'Save failed: no project open',
  'toast.closeOk': 'Project closed.',
  'toast.closeFailed': 'Close failed: {detail}',
  'toast.needDir': '{action} failed: enter a project directory first',
  'toast.simFailed': 'Simulation: {detail}',
  'toast.micFailed': 'Microphone capture failed: {detail}',

  // external firmware panel
  'toast.linkOk': 'External project linked.',
  'toast.linkFailed': 'Link failed: {detail}',
  'toast.linkNeedDir': 'Link failed: enter a PlatformIO/ESP-IDF project directory first',
  'toast.unlinkOk': 'External project unlinked.',
  'toast.unlinkFailed': 'Unlink failed: {detail}',
  'toast.rescanOk': 'Rescan complete.',
  'toast.rescanFailed': 'Rescan failed: {detail}',
  'toast.importOk': 'Firmware imported from {detail}.',
  'toast.importFailed': 'Import failed: {detail}',
  'toast.importNone': 'Import failed: no build/*.elf discovered yet',
  'firmware.current': 'firmware: {path}',
  'firmware.none': 'no firmware imported',

  // canvas interactions
  'canvas.wiringFrom': 'Wiring from {pin} — click a target pin (Esc cancels).',
  'canvas.wireCancelled': 'Wiring cancelled.',
  'canvas.wireCreated': 'Wire created: {from} <-> {to}.',
  'canvas.wireExists': 'Wire already exists.',
  'canvas.wireNotRoutable': 'Peripheral-to-peripheral wires are not routable (MVP) — connect via an MCU pin.',
  'canvas.placed': '{kind} placed. Click its pin, then an MCU GPIO pin, to wire.',
  'canvas.removedInstance': 'Removed {id} (its wires were removed from the netlist).',
  'canvas.removedWire': 'Wire removed.',
  'canvas.wireSelected': 'Wire selected — click again or press Delete to remove.',

  // empty-state guide
  'canvas.guide.title': 'Build your circuit in 3 steps',
  'canvas.guide.step1': 'Drag a peripheral from the palette onto the board',
  'canvas.guide.step2': 'Click a peripheral pin, then an MCU GPIO pin, to wire them',
  'canvas.guide.step3': 'Press Play and interact with your circuit',

  // canvas view controls
  'canvas.view.zoomIn': 'Zoom in',
  'canvas.view.zoomOut': 'Zoom out',
  'canvas.view.reset': 'Reset view',

  // palette
  'palette.title': 'Peripherals',
  'palette.searchPlaceholder': 'Search peripherals…',
  'palette.count': '{n} shown',
  'palette.noMatch': 'No matching peripherals',

  // top bar & help dialog
  'topbar.help': 'Help',
  'help.title': 'Keyboard & mouse',
  'help.section.editing': 'Editing',
  'help.section.canvas': 'Canvas',
  'help.keys.esc': 'Cancel pending wire / clear selection',
  'help.keys.delete': 'Delete selected instance / wire',
  'help.keys.undo': 'Undo (20-step history)',
  'help.keys.redo': 'Redo',
  'help.keys.zoom': 'Zoom at the pointer (25%–300%)',
  'help.keys.pan': 'Drag the empty canvas to pan',
  'help.keys.help': 'Toggle this help',

  // firmware group (popover trigger label)
  'firmware.title': 'Firmware',

  // bottom dock
  'dock.serial': 'Serial',
  'dock.scope': 'Scope',
  'dock.screen': 'Screen',
  'dock.wavegen': 'Wave gen',
  'dock.collapse': 'Collapse',
  'dock.expand': 'Instruments',

  // properties panel (RightPanel tabs)
  'props.title': 'Properties',
  'props.debug': 'Debug',
  'props.noneSelected': 'Select an instance or a wire on the canvas.',
  'props.pins': 'Pins',
  'props.rawProps': 'Raw props',
  'props.unknownKind': 'Unknown kind — read-only view.',
  'props.endpoints': 'Endpoints',
  'props.pin': 'Pin',
  'props.role': 'Role',

  // serial console
  'serial.idle': '[UART0 idle]',
  'serial.placeholder': 'type a line, Enter to send',
  'serial.placeholderDisabled': 'start the simulation to type',
  'serial.send': 'Send',

  // screen view
  'screen.title': 'Screen',
  'screen.empty': 'No screen peripheral active.',

  // oscilloscope panel
  'scope.title': 'Oscilloscope',
  'scope.empty': 'Place an Oscilloscope and wire CH1..CH4 to GPIO pins.',
  'scope.waiting': 'Waiting for signal…',

  // waveform generator
  'wavegen.title': 'Waveform Generator',
  'wavegen.empty': 'Place a Microphone to generate a waveform.',
  'wavegen.waveform': 'Waveform',
  'wavegen.frequency': 'Frequency',
  'wavegen.amplitude': 'Amplitude',
  'wavegen.sampleRate': 'Sample rate',
  'wavegen.bitDepth': 'Bit depth',
  'wavegen.channels': 'Channels',
  'wavegen.mono': 'Mono',
  'wavegen.stereo': 'Stereo',
  'wavegen.captureNote': 'Live capture is overriding the synth waveform.',

  // debug panel (Inspector)
  'debug.title': 'Debug',
  'debug.attach': 'Attach',
  'debug.detach': 'Detach',
  'debug.continue': 'Continue',
  'debug.stepIn': 'Step In',
  'debug.stepOver': 'Step Over',
  'debug.breakpoints': 'Breakpoints',
  'debug.set': 'Set',
  'debug.clear': 'Clear',
  'debug.if': 'If',
  'debug.condPlaceholder': 'condition (e.g. remaining == 0)',
  'debug.watchpoints': 'Watchpoints',
  'debug.add': 'Add',
  'debug.watch': 'Watch (globals/expressions)',
  'debug.variables': 'Variables',
  'debug.noFrame': '(no frame)',
  'debug.registers': 'Registers',
  'debug.stopped': 'stopped: {info}',

  // marketplace panel
  'market.title': 'Peripheral catalog',
  'market.rescan': 'Rescan',
  'market.scanning': 'Scanning…',
  'market.load': 'Load',
  'market.loading': 'Loading…',
  'market.root': 'in {dir}',
  'market.empty': 'No packages found. Drop a folder with a breadesp-peripheral.json manifest into the directory above.',

  // project wizard
  'wizard.title': 'New Project',
  'wizard.dir': 'Project directory',
  'wizard.dirPlaceholder': 'path/to/my-project (.breadesp)',
  'wizard.chip': 'Chip',
  'wizard.template': 'Template',
  'wizard.create': 'Create',
  'wizard.creating': 'Creating…',
} as const;

export type MessageKey = keyof typeof en;
