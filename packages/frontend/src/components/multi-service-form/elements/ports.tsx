import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import './elements.css';
import { removeTableRow, revealTableAction } from './reveal-table-action';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';
import type { dynamicComposeSchemaArk } from '@runtipi/common/schemas';
import { IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import { Controller, useFieldArray, type Control, type FieldErrors, type UseFormRegister } from 'react-hook-form';
import { Tooltip } from 'react-tooltip';
import { useTranslation } from 'react-i18next';

type Props = {
  control: Control<typeof dynamicComposeSchemaArk.infer>;
  register: UseFormRegister<typeof dynamicComposeSchemaArk.infer>;
  serviceIndex: number;
  errors?: FieldErrors<typeof dynamicComposeSchemaArk.infer>;
};

export const PortsConfig = ({ errors, serviceIndex, control, register }: Props) => {
  const { t } = useTranslation();
  const { fields, append, remove } = useFieldArray({
    control,
    name: `services.${serviceIndex}.addPorts`,
  });

  return (
    <div className="row g-4">
      <div className="col-12 service-config-group">
        <div className="service-config-toolbar mb-3">
          <div>
            <Tooltip className="tooltip" anchorSelect=".my-ports">
              {t('MULTI_SERVICE_PORTS_TITLE_TOOLTIP')}
            </Tooltip>
            {t('MULTI_SERVICE_PORTS_TITLE')} <span className="ms-1 form-help my-ports">?</span>
          </div>
          <Button type="button" onClick={() => append({ containerPort: 8080, hostPort: 8080 })} size="sm">
            {t('MULTI_SERVICE_PORTS_ADD_PORT')}
          </Button>
        </div>
        <Table className={clsx('service-config-table border p-1', { 'd-none': fields.length === 0 })}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('MULTI_SERVICE_PORTS_HOST_PORT')}</TableHead>
              <TableHead>{t('MULTI_SERVICE_PORTS_CONTAINER_PORT')}</TableHead>
              <TableHead className="service-config-check-cell">{t('MULTI_SERVICE_PORTS_TCP')}</TableHead>
              <TableHead className="service-config-check-cell">{t('MULTI_SERVICE_PORTS_UDP')}</TableHead>
              <TableHead>{t('MULTI_SERVICE_PORTS_INTERFACE')}</TableHead>
              <TableHead className="service-config-actions-cell" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {fields.map((field, index) => (
              <TableRow key={field.id}>
                <TableCell scope="row" className="w-30">
                  <Input
                    {...register(`services.${serviceIndex}.addPorts.${index}.hostPort`)}
                    aria-label={`${t('MULTI_SERVICE_PORTS_HOST_PORT')} ${index + 1}`}
                    error={t(errors?.services?.[serviceIndex]?.addPorts?.[index]?.hostPort?.message as string)}
                    placeholder="8080"
                    className="table-row-input"
                  />
                </TableCell>
                <TableCell className="w-30">
                  <Input
                    {...register(`services.${serviceIndex}.addPorts.${index}.containerPort`)}
                    aria-label={`${t('MULTI_SERVICE_PORTS_CONTAINER_PORT')} ${index + 1}`}
                    error={t(errors?.services?.[serviceIndex]?.addPorts?.[index]?.containerPort?.message as string)}
                    placeholder="8080"
                    className="table-row-input"
                  />
                </TableCell>
                <TableCell className="w-10 service-config-check-cell">
                  <Controller
                    control={control}
                    name={`services.${serviceIndex}.addPorts.${index}.tcp`}
                    defaultValue={true}
                    render={({ field: { onChange, value, ref, ...rest } }) => (
                      <Checkbox ref={ref} checked={value} onCheckedChange={onChange} {...rest} className="mb-0" aria-label={`TCP ${index + 1}`} />
                    )}
                  />
                </TableCell>
                <TableCell className="w-10 service-config-check-cell">
                  <Controller
                    control={control}
                    name={`services.${serviceIndex}.addPorts.${index}.udp`}
                    defaultValue={true}
                    render={({ field: { onChange, value, ref, ...rest } }) => (
                      <Checkbox ref={ref} checked={value} onCheckedChange={onChange} {...rest} className="mb-0" aria-label={`UDP ${index + 1}`} />
                    )}
                  />
                </TableCell>
                <TableCell className="w-30">
                  <Input
                    {...register(`services.${serviceIndex}.addPorts.${index}.interface`, { setValueAs: (v) => v.trim() || undefined })}
                    aria-label={`${t('MULTI_SERVICE_PORTS_INTERFACE')} ${index + 1}`}
                    error={errors?.services?.[serviceIndex]?.addPorts?.[index]?.interface?.message}
                    placeholder="eth0"
                  />
                </TableCell>
                <TableCell className="service-config-actions-cell">
                  <Button
                    type="button"
                    size="sm"
                    onClick={(event) => removeTableRow(event, () => remove(index))}
                    onFocus={revealTableAction}
                    className="btn-action service-config-remove"
                    aria-label={`${t('APP_ACTION_REMOVE')}: ${t('MULTI_SERVICE_PORTS_TITLE')} ${index + 1}`}
                    title={t('APP_ACTION_REMOVE')}
                  >
                    <IconX size={20} aria-hidden="true" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {fields.length === 0 && <div className="text-muted small">{t('MULTI_SERVICE_PORTS_NO_PORTS')}</div>}
      </div>
    </div>
  );
};
