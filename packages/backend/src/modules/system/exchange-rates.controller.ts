import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { ExchangeRatesService } from './exchange-rates.service';

@Controller('system')
export class ExchangeRatesController {
  constructor(private readonly exchangeRates: ExchangeRatesService) {}

  @UseGuards(AuthGuard)
  @Get('/exchange-rates')
  read() {
    return this.exchangeRates.read();
  }
}
