'use strict';
'require view';
'require rpc';
'require anygo.common as common';

var callGet = rpc.declare({ object: 'anygo', method: 'config_get' });
var callSet = rpc.declare({ object: 'anygo', method: 'config_set', params: [ 'amap_key', 'default_speed', 'max_devices' ] });

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	load: function() {
		common.loadStyles();
	},

	render: function() {
		return common.guardWorker(L.bind(function() {
			return callGet().catch(function() { return null; }).then(L.bind(this.renderPage, this));
		}, this));
	},

	renderPage: function(config) {
		var pageClass = common.themeClass() + ' anygo-settings';
		var heading = E('div', { class: 'anygo-heading' }, E('h2', {}, '高级设置'));
		if (!config || config.error || config.detail)
			return E('div', { class: pageClass }, [
				heading, E('p', { class: 'anygo-error', role: 'alert' }, '无法读取设置，请刷新后重试。')
			]);

		var key = E('input', { id: 'anygo-amap-key', type: 'password', value: config.amap_key || '', autocomplete: 'off' });
		var speed = E('input', {
			id: 'anygo-default-speed', type: 'number', value: config.default_speed || 1.4,
			step: 'any', min: '0', max: '100', required: ''
		});
		var reveal = common.button('显示 Key', function() {
			var visible = key.type === 'password';
			key.type = visible ? 'text' : 'password';
			reveal.textContent = visible ? '隐藏 Key' : '显示 Key';
		});
		var save = E('button', { type: 'submit', class: 'anygo-button anygo-button-primary' }, '保存设置');

		return E('div', { class: pageClass }, [
			heading,
			E('form', { class: 'anygo-panel', submit: function(ev) {
				ev.preventDefault();
				var value = Number(speed.value);
				if (!(value > 0 && value <= 100)) {
					common.notify('默认速度须大于 0，且不超过 100 m/s', 'warning');
					speed.focus();
					return;
				}
				if (save.disabled)
					return;
				save.disabled = true;
				callSet(key.value.trim(), value, config.max_devices).then(function(res) {
					if (!res || res.error || res.detail)
						throw new Error((res && (res.error || res.detail)) || '后台无响应');
					common.notify('设置已保存', 'success');
				}).catch(function(e) {
					common.notify('保存失败：' + e.message, 'danger');
				}).finally(function() { save.disabled = false; });
			} }, [
				E('div', { class: 'anygo-panel-body' }, [
					E('div', { class: 'anygo-key-row' }, [
						E('label', { class: 'anygo-field' }, [ E('span', {}, '高德 JSAPI Key'), key ]),
						reveal
					]),
					E('label', { class: 'anygo-field anygo-speed-input' }, [
						E('span', {}, '路线默认速度（m/s）'), speed
					])
				]),
				E('div', { class: 'anygo-panel-body' }, E('div', { class: 'anygo-actions' }, save))
			])
		]);
	}
});
