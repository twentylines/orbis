import { create } from 'zustand';
import { type } from 'arktype';
import { dynamicComposeSchemaArk, type serviceSchemaArk, convertYamlToLegacy } from '@runtipi/common/schemas';
import toast from 'react-hot-toast';
import { deepClean } from '@/utils/objects';
import { confirmDiscard } from '@/desktop/confirmation';

type MultiServiceFormData = typeof dynamicComposeSchemaArk.infer;
type ServiceFormData = typeof serviceSchemaArk.infer;

interface ServiceWithId extends ServiceFormData {
  _id: string;
}

interface MultiServiceState {
  // State
  services: ServiceWithId[];
  composeExtras: Record<string, unknown>;
  activeService: number | 'json';
  isDirty: boolean;
  error: string;
  validate: (values: typeof dynamicComposeSchemaArk.infer) => boolean;

  // Actions
  setActiveService: (tab: number | 'json') => Promise<void>;
  addService: () => Promise<void>;
  removeService: (index: number) => Promise<void>;
  updateService: (index: number, serviceData: ServiceFormData) => void;
  updateFromJson: (services: MultiServiceFormData['services']) => void;
  updateFromYaml: (yamlData: unknown) => void;
  resetToDefaults: () => void;
  setIsDirty: (dirty: boolean) => void;
  setServices: (services: ServiceWithId[]) => void;
  setComposeExtras: (composeExtras: Record<string, unknown>) => void;
}

const defaultService: ServiceFormData = {
  name: '',
  image: '',
  isMain: false,
  internalPort: 80,
  environment: [],
  volumes: [],
  addPorts: [],
};

const defaultServices: ServiceWithId[] = [
  {
    _id: generateId(),
    name: 'web',
    image: 'nginx:alpine',
    isMain: true,
    internalPort: 80,
  },
];

function generateId(): string {
  return `service-${Math.random().toString(36).substring(2, 9)}`;
}

export const useMultiServiceStore = create<MultiServiceState>()((set, get) => ({
  services: defaultServices,
  composeExtras: {},
  activeService: 0,
  isDirty: false,
  error: '',
  setServices: (services: ServiceWithId[]) => set({ services: deepClean(services) as ServiceWithId[] }),
  setComposeExtras: (composeExtras: Record<string, unknown>) => set({ composeExtras }),
  validate: (values: typeof dynamicComposeSchemaArk.infer) => {
    const res = dynamicComposeSchemaArk.omit('schemaVersion')(values);

    if (res instanceof type.errors) {
      console.error('Validating values:', values, res.summary);
      set({ error: 'Invalid configuration.' });
      return false;
    }

    // Ensure only one main service
    const mainServices = values.services.filter((service) => service.isMain);
    if (mainServices.length !== 1) {
      set({ error: 'There must be exactly one main service.' });
      return false;
    }

    // Ensure unique service names
    const names = values.services.map((service) => service.name);
    const uniqueNames = new Set(names);
    if (names.length !== uniqueNames.size) {
      set({ error: 'Service names must be unique.' });
      return false;
    }

    set({ error: '' });
    return true;
  },
  setActiveService: async (tab: number | 'json') => {
    const snapshot = get();
    const { activeService, isDirty } = snapshot;

    if (activeService === 'json' && isDirty && tab !== 'json') {
      if (!(await confirmDiscard('Changes in the JSON editor have not been saved.')) || get() !== snapshot) {
        return;
      }
    }

    set({ activeService: tab, isDirty: false });
  },

  addService: async () => {
    const snapshot = get();
    const { services, activeService, isDirty } = snapshot;
    if (activeService === 'json' && isDirty) {
      if (!(await confirmDiscard('Changes in the JSON editor have not been saved.')) || get() !== snapshot) {
        return;
      }
    }

    const newService: ServiceWithId = {
      ...defaultService,
      _id: generateId(),
      name: `service-${services.length + 1}`,
    };
    const newServices = [...services, newService];

    set({
      isDirty: false,
      services: newServices,
      activeService: services.length,
    });

    get().validate({ schemaVersion: 2, services: newServices });
  },

  removeService: async (index: number) => {
    const snapshot = get();
    const { activeService, isDirty, services } = snapshot;
    if (activeService === 'json' && isDirty) {
      if (!(await confirmDiscard('Changes in the JSON editor have not been saved.')) || get() !== snapshot) {
        return;
      }
    }

    if (services.length === 1) return;

    const newServices = services.filter((_, i) => i !== index);
    let newActiveTab = activeService;

    if (activeService === index || activeService === 'json') {
      newActiveTab = 0;
    } else if (activeService > index) {
      newActiveTab = activeService - 1;
    }

    set({
      isDirty: false,
      services: newServices,
      activeService: newActiveTab,
    });
    get().validate({ schemaVersion: 2, services: newServices });
  },

  updateService: (index: number, serviceData: ServiceFormData) => {
    const { services } = get();
    const existingService = services[index];

    if (existingService) {
      const newServices = [...services];
      newServices[index] = deepClean({ ...serviceData, _id: existingService._id }) as ServiceWithId;
      set({ services: newServices });
      get().validate({ schemaVersion: 2, services: newServices });
    }
  },

  updateFromJson: (newServices: MultiServiceFormData['services']) => {
    const servicesWithIds = deepClean(
      newServices.map((service, index) => ({
        ...service,
        _id: get().services[index]?._id || generateId(),
      })),
    ) as ServiceWithId[];

    get().validate({ schemaVersion: 2, services: servicesWithIds });

    const error = get().error;
    if (error) {
      toast.error(error);
      return;
    }

    set({ services: servicesWithIds, isDirty: false });
    toast.success('Services updated from JSON');
  },

  updateFromYaml: (yamlData: unknown) => {
    try {
      const legacy = convertYamlToLegacy(yamlData);
      const composeExtras =
        yamlData && typeof yamlData === 'object'
          ? Object.fromEntries(Object.entries(yamlData).filter(([key]) => key !== 'services' && key !== 'x-runtipi'))
          : {};
      const servicesWithIds = deepClean(
        legacy.services.map((service, index) => ({
          ...service,
          _id: get().services[index]?._id || generateId(),
        })),
      ) as ServiceWithId[];

      get().validate({ schemaVersion: 2, services: servicesWithIds });

      const error = get().error;
      if (error) {
        toast.error(error);
        return;
      }

      set({ services: servicesWithIds, composeExtras, isDirty: false });
      toast.success('Services updated from YAML');
    } catch (err) {
      console.error(err);
      toast.error('Failed to update services from YAML');
    }
  },

  resetToDefaults: () =>
    set({
      services: defaultServices.map((service) => ({ ...service, _id: generateId() })),
      activeService: 0,
      error: '',
      isDirty: false,
      composeExtras: {},
    }),

  setIsDirty: (dirty: boolean) => set({ isDirty: dirty }),
}));
