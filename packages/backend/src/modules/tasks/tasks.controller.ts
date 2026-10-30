import { Body, Controller, Get, Header, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import type { Request } from 'express';
import { TasksService } from './tasks.service';

@Controller('tasks')
@UseGuards(AuthGuard)
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get('attention')
  @Header('Cache-Control', 'private, no-store')
  attention(@Req() request: Request) {
    if (!request.user?.id) throw new UnauthorizedException();
    return this.tasks.readAttention(request.user.id);
  }

  @Post('attention')
  @Header('Cache-Control', 'private, no-store')
  acknowledge(@Req() request: Request, @Body() body: unknown) {
    if (!request.user?.id) throw new UnauthorizedException();
    return this.tasks.acknowledgeAttention(request.user.id, body);
  }

  @Get()
  get() {
    return this.tasks.read();
  }
}
