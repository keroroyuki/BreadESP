// i18n 字典 — 中文。Record<MessageKey, string> 保证与英文键集合编译期对齐。
import type { MessageKey } from './en';

export const zh: Record<MessageKey, string> = {
  // common
  'common.ok': '确定',
  'common.cancel': '取消',
  'common.close': '关闭',
  'common.delete': '删除',
  'common.undo': '撤销',
  'common.redo': '重做',
  'common.busy': '处理中…',

  // simulation status
  'sim.status.idle': '空闲',
  'sim.status.loaded': '已加载',
  'sim.status.running': '运行中',
  'sim.status.paused': '已暂停',
  'sim.status.stopped': '已停止',
  'sim.status.error': '错误',

  // toolbar
  'toolbar.new': '新建',
  'toolbar.open': '打开',
  'toolbar.save': '保存',
  'toolbar.saveAs': '另存为',
  'toolbar.close': '关闭',
  'toolbar.pause': '暂停',
  'toolbar.resume': '继续',
  'toolbar.reset': '重置',
  'toolbar.speed': '速度',
  'toolbar.dirPlaceholder': '工程目录（.breadesp）',
  'toolbar.noProject': '未打开工程',
  'toolbar.project': '工程：{dir}',

  // toasts
  'toast.newOk': '工程已创建。',
  'toast.openOk': '工程已打开。',
  'toast.openFailed': '打开失败：{detail}',
  'toast.saveOk': '工程已保存。',
  'toast.saveFailed': '保存失败：{detail}',
  'toast.saveAsOk': '工程已保存。',
  'toast.saveAsFailed': '另存为失败：{detail}',
  'toast.saveNoProject': '保存失败：未打开工程',
  'toast.closeOk': '工程已关闭。',
  'toast.closeFailed': '关闭失败：{detail}',
  'toast.needDir': '{action}失败：请先输入工程目录',
  'toast.simFailed': '仿真：{detail}',
  'toast.micFailed': '麦克风采集失败：{detail}',

  // external firmware panel
  'toast.linkOk': '已关联外部工程。',
  'toast.linkFailed': '关联失败：{detail}',
  'toast.linkNeedDir': '关联失败：请先输入 PlatformIO/ESP-IDF 工程目录',
  'toast.unlinkOk': '已解除关联。',
  'toast.unlinkFailed': '解除关联失败：{detail}',
  'toast.rescanOk': '重新扫描完成。',
  'toast.rescanFailed': '重新扫描失败：{detail}',
  'toast.importOk': '已从 {detail} 导入固件。',
  'toast.importFailed': '导入失败：{detail}',
  'toast.importNone': '导入失败：尚未发现 build/*.elf',
  'firmware.current': '固件：{path}',
  'firmware.none': '未导入固件',

  // canvas interactions
  'canvas.wiringFrom': '正在从 {pin} 连线 — 点击目标引脚（Esc 取消）。',
  'canvas.wireCancelled': '已取消连线。',
  'canvas.wireCreated': '已创建连线：{from} <-> {to}。',
  'canvas.wireExists': '连线已存在。',
  'canvas.wireNotRoutable': '外设间直连暂不支持（MVP）— 请通过 MCU 引脚连接。',
  'canvas.placed': '已放置 {kind}。点击其引脚，再点击 MCU GPIO 引脚完成连线。',
  'canvas.removedInstance': '已移除 {id}（其连线已从网表中删除）。',
  'canvas.removedWire': '已删除连线。',
  'canvas.wireSelected': '已选中连线 — 再次点击或按 Delete 删除。',

  // empty-state guide
  'canvas.guide.title': '三步搭建你的电路',
  'canvas.guide.step1': '从左侧元件库拖动元件到面包板',
  'canvas.guide.step2': '点击元件引脚，再点击 MCU GPIO 引脚完成连线',
  'canvas.guide.step3': '点击运行，与你的电路交互',

  // canvas view controls
  'canvas.view.zoomIn': '放大',
  'canvas.view.zoomOut': '缩小',
  'canvas.view.reset': '重置视图',

  // palette
  'palette.title': '元件库',
  'palette.searchPlaceholder': '搜索元件…',
  'palette.count': '显示 {n} 个',
  'palette.noMatch': '没有匹配的元件',

  // top bar & help dialog
  'topbar.help': '帮助',
  'help.title': '键盘与鼠标操作',
  'help.section.editing': '编辑',
  'help.section.canvas': '画布',
  'help.keys.esc': '取消连线 / 清空选中',
  'help.keys.delete': '删除选中的元件或连线',
  'help.keys.undo': '撤销（20 步历史）',
  'help.keys.redo': '重做',
  'help.keys.zoom': '以鼠标为锚缩放（25%–300%）',
  'help.keys.pan': '拖拽空白处平移画布',
  'help.keys.help': '打开/关闭本帮助',

  // firmware group (popover trigger label)
  'firmware.title': '固件',

  // bottom dock
  'dock.serial': '串口',
  'dock.scope': '示波器',
  'dock.screen': '屏幕',
  'dock.wavegen': '波形发生器',
  'dock.collapse': '折叠',
  'dock.expand': '仪器面板',

  // properties panel (RightPanel tabs)
  'props.title': '属性',
  'props.debug': '调试',
  'props.noneSelected': '在画布上选择一个元件或连线。',
  'props.pins': '引脚',
  'props.rawProps': '原始属性',
  'props.unknownKind': '未知类型——只读视图。',
  'props.endpoints': '端点',
  'props.pin': '引脚',
  'props.role': '角色',

  // serial console
  'serial.idle': '[UART0 空闲]',
  'serial.placeholder': '输入一行，回车发送',
  'serial.placeholderDisabled': '启动仿真后可输入',
  'serial.send': '发送',

  // screen view
  'screen.title': '屏幕',
  'screen.empty': '没有活动的屏幕外设。',

  // oscilloscope panel
  'scope.title': '示波器',
  'scope.empty': '放置一个示波器并将 CH1..CH4 接到 GPIO 引脚。',
  'scope.waiting': '等待信号…',

  // waveform generator
  'wavegen.title': '波形发生器',
  'wavegen.empty': '放置一个麦克风以生成波形。',
  'wavegen.waveform': '波形',
  'wavegen.frequency': '频率',
  'wavegen.amplitude': '幅度',
  'wavegen.sampleRate': '采样率',
  'wavegen.bitDepth': '位深',
  'wavegen.channels': '声道',
  'wavegen.mono': '单声道',
  'wavegen.stereo': '立体声',
  'wavegen.captureNote': '实时采集正在覆盖合成波形。',

  // debug panel (Inspector)
  'debug.title': '调试',
  'debug.attach': '附加',
  'debug.detach': '分离',
  'debug.continue': '继续',
  'debug.stepIn': '单步进入',
  'debug.stepOver': '单步跳过',
  'debug.breakpoints': '断点',
  'debug.set': '设置',
  'debug.clear': '清除',
  'debug.if': '条件',
  'debug.condPlaceholder': '条件（如 remaining == 0）',
  'debug.watchpoints': '观察点',
  'debug.add': '添加',
  'debug.watch': '监视（全局/表达式）',
  'debug.variables': '变量',
  'debug.noFrame': '（无栈帧）',
  'debug.registers': '寄存器',
  'debug.stopped': '已停止：{info}',

  // marketplace panel
  'market.title': '外设目录',
  'market.rescan': '重新扫描',
  'market.scanning': '扫描中…',
  'market.load': '加载',
  'market.loading': '加载中…',
  'market.root': '位于 {dir}',
  'market.empty': '未发现扩展包。请将包含 breadesp-peripheral.json 清单的文件夹放入上方目录。',

  // project wizard
  'wizard.title': '新建工程',
  'wizard.dir': '工程目录',
  'wizard.dirPlaceholder': 'path/to/my-project (.breadesp)',
  'wizard.chip': '芯片',
  'wizard.template': '模板',
  'wizard.create': '创建',
  'wizard.creating': '创建中…',
};
