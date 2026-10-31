import { Injectable } from '@nestjs/common';
import { DeviceStore, type Device } from '../devices/device-store';
import { LearningService } from './learning.service';
import { authorizeDeviceLearning, currentLearningDevice, deviceLearningEnvelope } from './device-learning-auth';

/** Devices may report observations and read approved context; human review is deliberately absent. */
@Injectable()
export class DeviceLearningService {
    constructor(
        private readonly devices: DeviceStore,
        private readonly learning: LearningService,
    ) {}
    async context(original: Device, value: unknown) {
        const target = deviceLearningEnvelope(value),
            device = await currentLearningDevice(this.devices, original, target, 1);
        const result = await this.learning.deviceContext(
            { email: device.email, activeRole: device.role },
            target.projectId,
            (db) => authorizeDeviceLearning(db, device, target),
        );
        await currentLearningDevice(this.devices, device, target, 1);
        return result;
    }
    async record(original: Device, value: unknown) {
        const target = deviceLearningEnvelope(value, true),
            device = await currentLearningDevice(this.devices, original, target, 2);
        return this.learning.recordDeviceExperience(
            { email: device.email, activeRole: device.role },
            target.projectId,
            target.input,
            { deviceId: device.id, bindingId: target.bindingId, instanceId: target.instanceId },
            (db) => authorizeDeviceLearning(db, device, target),
        );
    }
    async observe(original: Device, value: unknown) {
        const target = deviceLearningEnvelope(value, true),
            device = await currentLearningDevice(this.devices, original, target, 2);
        return this.learning.appendDeviceExperience(
            { email: device.email, activeRole: device.role },
            target.projectId,
            target.input,
            { deviceId: device.id, bindingId: target.bindingId, instanceId: target.instanceId },
            (db) => authorizeDeviceLearning(db, device, target),
        );
    }
    async propose(original: Device, value: unknown) {
        const target = deviceLearningEnvelope(value, true),
            device = await currentLearningDevice(this.devices, original, target, 2);
        return this.learning.proposeDeviceHypothesis(
            { email: device.email, activeRole: device.role },
            target.projectId,
            target.input,
            { deviceId: device.id, bindingId: target.bindingId, instanceId: target.instanceId },
            (db) => authorizeDeviceLearning(db, device, target),
        );
    }
}
